import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp, toEcobeeTemp } from "../ecobee/types.js";
import {
  boundedString,
  dateSchema,
  destructiveMutationAnnotations,
  MAX_EVENTS,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  registerEcobeeTool,
  structuredResult,
  temperatureSchema,
  timeSchema,
} from "./contracts.js";
import { resolveId } from "./set-temperature.js";

const vacationInputSchema = z.strictObject({
  name: boundedString(12).min(1).optional(),
  coolTemp: temperatureSchema.optional(),
  heatTemp: temperatureSchema.optional(),
  startDate: dateSchema,
  startTime: timeSchema.default("00:00:00"),
  endDate: dateSchema,
  endTime: timeSchema.default("00:00:00"),
});

const inputSchema = z
  .object({
    action: z.enum(["create", "delete"]),
    thermostatId: optionalThermostatIdSchema,
    name: boundedString(12).min(1).optional(),
    coolTemp: temperatureSchema.optional(),
    heatTemp: temperatureSchema.optional(),
    startDate: dateSchema.optional(),
    startTime: timeSchema.default("00:00:00"),
    endDate: dateSchema.optional(),
    endTime: timeSchema.default("00:00:00"),
    vacations: z.array(vacationInputSchema).min(1).max(32).optional(),
    vacationName: boundedString(12).min(1).optional(),
    dryRun: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.action === "delete" && !value.vacationName) {
      ctx.addIssue({
        code: "custom",
        path: ["vacationName"],
        message: "vacationName is required for delete.",
      });
    }
    if (
      value.action === "create" &&
      !value.vacations &&
      (!value.startDate || !value.endDate)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "Provide startDate/endDate or a vacations array.",
      });
    }
  });

const normalizedVacationSchema = z.object({
  name: boundedString(12),
  coolTemp: temperatureSchema,
  heatTemp: temperatureSchema,
  startDate: dateSchema,
  startTime: timeSchema,
  endDate: dateSchema,
  endTime: timeSchema,
});

const vacationStateSchema = normalizedVacationSchema.extend({
  running: z.boolean(),
});

const outputSchema = z.object({
  thermostatId: boundedString(64),
  requestedChange: z.object({
    action: z.enum(["create", "delete"]),
    dryRun: z.boolean(),
    vacationName: boundedString(12).optional(),
    vacations: z.array(normalizedVacationSchema).max(32),
  }),
  resultingState: z.object({
    vacations: z.array(vacationStateSchema).max(MAX_EVENTS).nullable(),
    verification: z.union([z.literal("preview"), mutationVerificationSchema]),
  }),
});

type VacationInput = z.output<typeof vacationInputSchema>;
type NormalizedVacation = z.output<typeof normalizedVacationSchema>;

export function registerSetVacation(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "set_vacation",
    {
      description:
        "Create or delete bounded vacation events using thermostat-local dates and times. Use dryRun=true to preview without writing.",
      inputSchema,
      outputSchema,
      annotations: destructiveMutationAnnotations,
    },
    async (args) => {
      const thermostatId = await resolveId(args.thermostatId, api, cache);
      if (args.action === "delete") {
        return deleteVacation(
          thermostatId,
          args.vacationName!,
          args.dryRun,
          api,
          cache,
        );
      }
      return createVacations(thermostatId, args, api, cache);
    },
  );
}

async function createVacations(
  thermostatId: string,
  args: z.output<typeof inputSchema>,
  api: EcobeeApiClient,
  cache: EcobeeCache,
) {
  const current = await readVacations(api, thermostatId);
  const existingNames = new Set(current.map((vacation) => vacation.name));
  const defaultHeat = current[0]?.heatTemp ?? 65;
  const defaultCool = current[0]?.coolTemp ?? 78;
  const inputs: VacationInput[] = args.vacations ?? [
    {
      name: args.name,
      coolTemp: args.coolTemp,
      heatTemp: args.heatTemp,
      startDate: args.startDate!,
      startTime: args.startTime,
      endDate: args.endDate!,
      endTime: args.endTime,
    },
  ];

  const vacations = inputs.map((vacation) => {
    let name =
      vacation.name ??
      generateVacationName(vacation.startDate, vacation.endDate);
    if (existingNames.has(name)) name = makeUniqueName(name, existingNames);
    existingNames.add(name);
    return {
      name,
      coolTemp: vacation.coolTemp ?? defaultCool,
      heatTemp: vacation.heatTemp ?? defaultHeat,
      startDate: vacation.startDate,
      startTime: normalizeTime(vacation.startTime),
      endDate: vacation.endDate,
      endTime: normalizeTime(vacation.endTime),
    } satisfies NormalizedVacation;
  });

  if (args.dryRun) {
    return structuredResult(
      outputSchema,
      {
        thermostatId,
        requestedChange: { action: "create", dryRun: true, vacations },
        resultingState: {
          vacations: vacations.map((vacation) => ({
            ...vacation,
            running: false,
          })),
          verification: "preview",
        },
      },
      {
        dryRun: true,
        defaults: { heatTemp: defaultHeat, coolTemp: defaultCool },
        vacations: vacations.map((vacation) => ({
          ...vacation,
          coolTempEcobee: toEcobeeTemp(vacation.coolTemp),
          heatTempEcobee: toEcobeeTemp(vacation.heatTemp),
        })),
      },
    );
  }

  const payload = vacations.map((vacation) => ({
    name: vacation.name,
    coolHoldTemp: toEcobeeTemp(vacation.coolTemp),
    heatHoldTemp: toEcobeeTemp(vacation.heatTemp),
    startDate: vacation.startDate,
    startTime: vacation.startTime,
    endDate: vacation.endDate,
    endTime: vacation.endTime,
  }));

  // One delivery attempt only. A failed bulk delivery is never expanded into
  // individual retries because the remote side may already have applied it.
  if (payload.length > 1) {
    await api.createVacationsBulk(thermostatId, payload);
  } else {
    await api.createVacation(thermostatId, payload[0]);
  }
  cache.invalidate(thermostatId);

  const resulting = await readVacations(api, thermostatId).catch(() => null);
  const names = new Set(vacations.map((vacation) => vacation.name));
  const matched =
    resulting?.filter((vacation) => names.has(vacation.name)) ?? null;
  const confirmed =
    matched !== null &&
    vacations.every((requested) =>
      matched.some(
        (observed) =>
          observed.name === requested.name &&
          observed.coolTemp === requested.coolTemp &&
          observed.heatTemp === requested.heatTemp &&
          observed.startDate === requested.startDate &&
          observed.startTime === requested.startTime &&
          observed.endDate === requested.endDate &&
          observed.endTime === requested.endTime,
      ),
    );
  return structuredResult(
    outputSchema,
    {
      thermostatId,
      requestedChange: { action: "create", dryRun: false, vacations },
      resultingState: {
        vacations: matched,
        verification:
          matched === null
            ? "unavailable"
            : confirmed
              ? "confirmed"
              : "accepted",
      },
    },
    `Created ${vacations.length} vacation event${vacations.length === 1 ? "" : "s"}.`,
  );
}

async function deleteVacation(
  thermostatId: string,
  vacationName: string,
  dryRun: boolean,
  api: EcobeeApiClient,
  cache: EcobeeCache,
) {
  if (!dryRun) {
    await api.deleteVacation(thermostatId, vacationName);
    cache.invalidate(thermostatId);
  }
  const resulting = await readVacations(api, thermostatId).catch(() => null);
  const stillPresent = resulting?.some(
    (vacation) => vacation.name === vacationName,
  );
  return structuredResult(
    outputSchema,
    {
      thermostatId,
      requestedChange: {
        action: "delete",
        dryRun,
        vacationName,
        vacations: [],
      },
      resultingState: {
        vacations: resulting,
        verification: dryRun
          ? "preview"
          : resulting === null
            ? "unavailable"
            : stillPresent
              ? "accepted"
              : "confirmed",
      },
    },
    dryRun
      ? `Vacation "${vacationName}" deletion previewed.`
      : resulting === null
        ? `Vacation "${vacationName}" deletion was accepted; readback was unavailable.`
        : stillPresent
          ? `Vacation "${vacationName}" deletion was accepted; readback is not yet confirmed.`
          : `Vacation "${vacationName}" deleted from thermostat ${thermostatId}.`,
  );
}

async function readVacations(
  api: EcobeeApiClient,
  thermostatId: string,
): Promise<Array<z.output<typeof vacationStateSchema>>> {
  const thermostats = await api.getThermostats({
    selectionType: "thermostats",
    selectionMatch: thermostatId,
    includeEvents: true,
  });
  return (thermostats[0]?.events ?? [])
    .filter((event) => event.type === "vacation")
    .slice(0, MAX_EVENTS)
    .map((event) => ({
      name: event.name,
      running: event.running,
      coolTemp: fromEcobeeTemp(event.coolHoldTemp),
      heatTemp: fromEcobeeTemp(event.heatHoldTemp),
      startDate: event.startDate,
      startTime: event.startTime,
      endDate: event.endDate,
      endTime: event.endTime,
    }));
}

/** Generate a stable vacation name that fits Ecobee's 12-character limit. */
function generateVacationName(startDate: string, endDate: string): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return `${months[start.getUTCMonth()]}${String(start.getUTCDate()).padStart(2, "0")}-${months[end.getUTCMonth()]}${String(end.getUTCDate()).padStart(2, "0")}`;
}

function makeUniqueName(baseName: string, existing: Set<string>): string {
  for (let counter = 2; counter < 10_000; counter++) {
    const suffix = String(counter);
    const candidate = `${baseName.slice(0, 12 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("Unable to generate a unique vacation name.");
}

function normalizeTime(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}
