import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

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
  all: [...EQUIPMENT_COLUMNS, ...ENVIRONMENT_COLUMNS, "hvacMode", "zoneClimate"],
};

export function registerGetRuntimeReport(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_runtime_report",
    {
      description:
        'Get historical runtime data for a thermostat. Returns equipment usage (seconds), temperatures, and HVAC mode in 5-minute intervals. Use preset "equipment" for heat/cool/fan runtimes, "environment" for temps/humidity, or "all" for everything. Max 31 days per request.',
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        startDate: z
          .string()
          .describe("Start date in YYYY-MM-DD format"),
        endDate: z
          .string()
          .describe("End date in YYYY-MM-DD format"),
        preset: z
          .enum(["equipment", "environment", "all"])
          .optional()
          .describe('Column preset. Use this OR columns, not both. Default: "all"'),
        columns: z
          .array(z.string())
          .optional()
          .describe(
            "Custom columns to include (e.g., ['compHeat1', 'fan', 'zoneAveTemp']). Overrides preset.",
          ),
        summarize: z
          .boolean()
          .default(true)
          .describe(
            "If true (default), returns daily summaries instead of raw 5-minute intervals. Equipment columns show total seconds per day, temps show daily averages.",
          ),
      },
    },
    async ({ thermostatId, startDate, endDate, preset, columns, summarize }) => {
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
        return {
          content: [
            { type: "text" as const, text: "No runtime data available." },
          ],
        };
      }

      const thermostatReport = report.reportList[0];
      const columnNames = report.columns.split(",");

      if (summarize) {
        const dailySummaries = summarizeByDay(
          thermostatReport.rowList,
          columnNames,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { thermostatId: id, startDate, endDate, dailySummaries },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Raw intervals
      const rows = thermostatReport.rowList.map((row) => {
        const values = row.split(",");
        const obj: Record<string, string> = {
          date: values[0],
          time: values[1],
        };
        for (let i = 2; i < values.length; i++) {
          obj[columnNames[i - 2]] = values[i];
        }
        return obj;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                thermostatId: id,
                startDate,
                endDate,
                intervals: rows.length,
                data: rows,
              },
              null,
              2,
            ),
          },
        ],
      };
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
    const values = row.split(",");
    const date = values[0];
    if (!date) continue;

    if (!days[date]) {
      days[date] = { sums: {}, counts: {} };
    }

    for (let i = 2; i < values.length; i++) {
      const col = columnNames[i - 2];
      const val = values[i];
      if (val === "" || val === undefined) continue;

      const num = Number(val);
      if (isNaN(num)) continue;

      days[date].sums[col] = (days[date].sums[col] ?? 0) + num;
      days[date].counts[col] = (days[date].counts[col] ?? 0) + 1;
    }
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
        result[date][col] = Math.round(
          (data.sums[col] / data.counts[col]) * 10,
        ) / 10;
      }
    }
  }

  return result;
}
