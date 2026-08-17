import { schema as s } from "../schema.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  dateSchema,
  finiteNumber,
  MAX_RUNTIME_ROWS,
  optionalThermostatIdSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const EQUIPMENT_COLUMNS = [
  "auxHeat1",
  "auxHeat2",
  "auxHeat3",
  "compCool1",
  "compCool2",
  "compHeat1",
  "compHeat2",
  "fan",
  "humidifier",
  "dehumidifier",
  "economizer",
  "ventilator",
];

const ENVIRONMENT_COLUMNS = [
  "zoneAveTemp",
  "zoneCoolTemp",
  "zoneHeatTemp",
  "zoneHumidity",
  "outdoorTemp",
  "outdoorHumidity",
];

const ALL_PRESETS: Record<string, string[]> = {
  equipment: EQUIPMENT_COLUMNS,
  environment: ENVIRONMENT_COLUMNS,
  all: [
    ...EQUIPMENT_COLUMNS,
    ...ENVIRONMENT_COLUMNS,
    "hvacMode",
    "zoneClimate",
  ],
};

const inputSchema = s
  .object({
    thermostatId: optionalThermostatIdSchema,
    startDate: dateSchema.describe("Start date in YYYY-MM-DD format"),
    endDate: dateSchema.describe("End date in YYYY-MM-DD format"),
    preset: s
      .enum(["equipment", "environment", "all"])
      .optional()
      .describe('Column preset. Use this OR columns, not both. Default: "all"'),
    columns: s
      .array(boundedString(64).min(1))
      .min(1)
      .max(32)
      .optional()
      .describe("Custom Ecobee runtime columns. Overrides preset."),
    summarize: s.boolean().default(true),
  })
  .refine(
    ({ startDate, endDate }) => {
      const start = Date.parse(`${startDate}T00:00:00Z`);
      const end = Date.parse(`${endDate}T00:00:00Z`);
      return (
        Number.isFinite(start) && end >= start && end - start <= 30 * 86_400_000
      );
    },
    {
      message: "Date range must be valid, ordered, and no longer than 31 days.",
    },
  );

const numericColumnsSchema = s
  .record(boundedString(64), finiteNumber)
  .meta({ maxProperties: 32 });
const outputSchema = s.object({
  thermostatId: boundedString(64),
  startDate: dateSchema,
  endDate: dateSchema,
  mode: s.enum(["summary", "intervals"]),
  dailySummaries: s
    .record(dateSchema, numericColumnsSchema)
    .meta({ maxProperties: 31 })
    .optional(),
  intervalCount: s.number().int().min(0).max(MAX_RUNTIME_ROWS).optional(),
  data: s
    .array(
      s
        .record(boundedString(64), boundedString(512))
        .meta({ maxProperties: 34 }),
    )
    .max(MAX_RUNTIME_ROWS)
    .optional(),
});

export function registerGetRuntimeReport(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_runtime_report",
    {
      description:
        'Get historical runtime data for a thermostat. Returns equipment usage (seconds), temperatures, and HVAC mode in 5-minute intervals. Use preset "equipment" for heat/cool/fan runtimes, "environment" for temps/humidity, or "all" for everything. Max 31 days per request.',
      inputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({
      thermostatId,
      startDate,
      endDate,
      preset,
      columns,
      summarize,
    }) => {
      const id = await resolveId(thermostatId, api, cache);

      const columnList = columns ?? ALL_PRESETS[preset ?? "all"];

      const report = await api.getRuntimeReport({
        selection: {
          selectionType: "thermostats",
          selectionMatch: id,
        },
        startDate,
        endDate,
        columns: columnList.join(","),
      });

      if (!report.reportList || report.reportList.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: id,
            startDate,
            endDate,
            mode: summarize ? "summary" : "intervals",
            ...(summarize
              ? { dailySummaries: {} }
              : { intervalCount: 0, data: [] }),
          },
          "No runtime data available.",
        );
      }

      const thermostatReport = report.reportList[0];
      const columnNames = report.columns.split(",");

      if (summarize) {
        const dailySummaries = summarizeByDay(
          thermostatReport.rowList,
          columnNames,
        );
        return structuredResult(outputSchema, {
          thermostatId: id,
          startDate,
          endDate,
          mode: "summary",
          dailySummaries,
        });
      }

      // Raw intervals
      const rows = new Array<Record<string, string>>(
        thermostatReport.rowList.length,
      );
      for (let index = 0; index < thermostatReport.rowList.length; index++) {
        rows[index] = parseRuntimeRow(
          thermostatReport.rowList[index],
          columnNames,
        );
      }

      return structuredResult(outputSchema, {
        thermostatId: id,
        startDate,
        endDate,
        mode: "intervals",
        intervalCount: rows.length,
        data: rows,
      });
    },
  );
}

function summarizeByDay(
  rowList: string[],
  columnNames: string[],
): Record<string, Record<string, number>> {
  const days: Record<
    string,
    { sums: Record<string, number>; counts: Record<string, number> }
  > = {};

  for (const row of rowList) {
    const firstComma = row.indexOf(",");
    if (firstComma < 0) continue;
    const date = row.slice(0, firstComma);
    if (!date) continue;

    if (!days[date]) {
      days[date] = { sums: {}, counts: {} };
    }

    forEachRuntimeValue(row, firstComma, (columnIndex, value) => {
      if (value === "") return;
      const column = columnNames[columnIndex];
      if (column === undefined) return;
      const number = Number(value);
      if (Number.isNaN(number)) return;
      days[date].sums[column] = (days[date].sums[column] ?? 0) + number;
      days[date].counts[column] = (days[date].counts[column] ?? 0) + 1;
    });
  }

  const result: Record<string, Record<string, number>> = {};

  for (const [date, data] of Object.entries(days)) {
    result[date] = {};
    for (const col of columnNames) {
      if (data.sums[col] === undefined) continue;

      // Equipment columns (runtime in seconds): sum them
      // Temperature/humidity columns: average them
      if (EQUIPMENT_COLUMNS.includes(col)) {
        result[date][col] = data.sums[col];
      } else {
        result[date][col] =
          Math.round((data.sums[col] / data.counts[col]) * 10) / 10;
      }
    }
  }

  return result;
}

function parseRuntimeRow(
  row: string,
  columnNames: string[],
): Record<string, string> {
  const firstComma = row.indexOf(",");
  const secondComma = firstComma < 0 ? -1 : row.indexOf(",", firstComma + 1);
  const result: Record<string, string> = {
    date: firstComma < 0 ? row : row.slice(0, firstComma),
    time:
      secondComma < 0
        ? firstComma < 0
          ? ""
          : row.slice(firstComma + 1)
        : row.slice(firstComma + 1, secondComma),
  };
  if (secondComma < 0) return result;

  forEachRuntimeValue(row, firstComma, (columnIndex, value) => {
    const column = columnNames[columnIndex];
    if (column !== undefined) result[column] = value;
  });
  return result;
}

function forEachRuntimeValue(
  row: string,
  firstComma: number,
  visit: (columnIndex: number, value: string) => void,
): void {
  const secondComma = row.indexOf(",", firstComma + 1);
  if (secondComma < 0) return;
  let start = secondComma + 1;
  let columnIndex = 0;
  for (let index = start; index <= row.length; index++) {
    if (index === row.length || row.charCodeAt(index) === 44) {
      visit(columnIndex++, row.slice(start, index));
      start = index + 1;
    }
  }
}
