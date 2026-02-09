import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp, toEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

const vacationSchema = z.object({
  name: z
    .string()
    .optional()
    .describe('Vacation name. Auto-generated if omitted (e.g., "Vacation 2026-03-01 to 2026-03-08")'),
  coolTemp: z.number().optional().describe("Cool set point in degrees F. Defaults to most recent vacation's value, or 78°F."),
  heatTemp: z.number().optional().describe("Heat set point in degrees F. Defaults to most recent vacation's value, or 65°F."),
  startDate: z
    .string()
    .describe("Start date in YYYY-MM-DD format (thermostat local time)"),
  startTime: z
    .string()
    .default("00:00:00")
    .describe("Start time in HH:mm:ss format (thermostat local time). Defaults to 00:00:00"),
  endDate: z
    .string()
    .describe("End date in YYYY-MM-DD format (thermostat local time)"),
  endTime: z
    .string()
    .default("00:00:00")
    .describe("End time in HH:mm:ss format (thermostat local time). Defaults to 00:00:00"),
});

export function registerSetVacation(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "set_vacation",
    {
      description:
        "Create or delete vacation events on the thermostat. Supports bulk creation. All times are thermostat-local (not UTC). Temperatures default to most recent vacation's values (or 65°F heat / 78°F cool). Use dryRun=true to preview computed names, temps, and times without creating.",
      inputSchema: {
        action: z.enum(["create", "delete"]).describe("Create or delete a vacation"),
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        // Single create fields
        name: z
          .string()
          .optional()
          .describe("Vacation name (for single create). Auto-generated if omitted."),
        coolTemp: z
          .number()
          .optional()
          .describe("Cool set point in degrees F. Defaults to most recent vacation's value, or 78°F."),
        heatTemp: z
          .number()
          .optional()
          .describe("Heat set point in degrees F. Defaults to most recent vacation's value, or 65°F."),
        startDate: z
          .string()
          .optional()
          .describe("Start date YYYY-MM-DD (for single create)"),
        startTime: z
          .string()
          .optional()
          .default("00:00:00")
          .describe("Start time HH:mm:ss (for single create). Defaults to 00:00:00"),
        endDate: z
          .string()
          .optional()
          .describe("End date YYYY-MM-DD (for single create)"),
        endTime: z
          .string()
          .optional()
          .default("00:00:00")
          .describe("End time HH:mm:ss (for single create). Defaults to 00:00:00"),
        // Bulk create
        vacations: z
          .array(vacationSchema)
          .optional()
          .describe("Array of vacation objects for bulk creation"),
        // Delete
        vacationName: z
          .string()
          .optional()
          .describe("Name of vacation to delete (for delete action)"),
        // Options
        dryRun: z
          .boolean()
          .default(false)
          .describe("If true, returns computed names/times without creating"),
      },
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      if (args.action === "delete") {
        return await handleDelete(id, args.vacationName, api, cache);
      }

      return await handleCreate(id, args, api, cache);
    },
  );
}

interface CreateArgs {
  name?: string;
  coolTemp?: number;
  heatTemp?: number;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  vacations?: z.infer<typeof vacationSchema>[];
  dryRun: boolean;
}

async function handleCreate(
  thermostatId: string,
  args: CreateArgs,
  api: EcobeeApiClient,
  cache: EcobeeCache,
) {
  // Pre-fetch existing vacations for name uniqueness and default temps
  const existing = await api.getThermostats({
    selectionType: "thermostats",
    selectionMatch: thermostatId,
    includeEvents: true,
  });

  const existingVacations = (existing[0]?.events ?? []).filter(
    (e) => e.type === "vacation",
  );
  const existingNames = new Set(existingVacations.map((e) => e.name));

  // Derive default temps from most recent existing vacation, or use 65/78
  const defaultHeat = existingVacations.length > 0
    ? fromEcobeeTemp(existingVacations[0].heatHoldTemp)
    : 65;
  const defaultCool = existingVacations.length > 0
    ? fromEcobeeTemp(existingVacations[0].coolHoldTemp)
    : 78;

  // Build vacation list from either single or bulk input
  let vacations: Array<{
    name: string;
    coolTemp: number;
    heatTemp: number;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
  }>;

  if (args.vacations && args.vacations.length > 0) {
    vacations = args.vacations.map((v) => ({
      name: v.name ?? generateVacationName(v.startDate, v.endDate),
      coolTemp: v.coolTemp ?? defaultCool,
      heatTemp: v.heatTemp ?? defaultHeat,
      startDate: v.startDate,
      startTime: normalizeTime(v.startTime),
      endDate: v.endDate,
      endTime: normalizeTime(v.endTime),
    }));
  } else if (args.startDate && args.endDate) {
    vacations = [
      {
        name:
          args.name ?? generateVacationName(args.startDate, args.endDate),
        coolTemp: args.coolTemp ?? defaultCool,
        heatTemp: args.heatTemp ?? defaultHeat,
        startDate: args.startDate,
        startTime: normalizeTime(args.startTime),
        endDate: args.endDate,
        endTime: normalizeTime(args.endTime),
      },
    ];
  } else {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: Provide startDate/endDate for single creation, or vacations array for bulk.",
        },
      ],
      isError: true,
    };
  }

  // Ensure unique names
  for (const v of vacations) {
    if (existingNames.has(v.name)) {
      v.name = makeUniqueName(v.name, existingNames);
    }
    existingNames.add(v.name);
  }

  // Dry run: return computed values without creating
  if (args.dryRun) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              dryRun: true,
              defaults: { heatTemp: defaultHeat, coolTemp: defaultCool },
              vacations: vacations.map((v) => ({
                ...v,
                coolTempEcobee: toEcobeeTemp(v.coolTemp),
                heatTempEcobee: toEcobeeTemp(v.heatTemp),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Convert temps to Ecobee format
  const ecobeeVacations = vacations.map((v) => ({
    name: v.name,
    coolHoldTemp: toEcobeeTemp(v.coolTemp),
    heatHoldTemp: toEcobeeTemp(v.heatTemp),
    startDate: v.startDate,
    startTime: v.startTime,
    endDate: v.endDate,
    endTime: v.endTime,
  }));

  // Try bulk create first
  if (ecobeeVacations.length > 1) {
    try {
      await api.createVacationsBulk(thermostatId, ecobeeVacations);
      cache.invalidate(thermostatId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully created ${ecobeeVacations.length} vacation events:\n${vacations.map((v) => `  - ${v.name}: ${v.startDate} to ${v.endDate}`).join("\n")}`,
          },
        ],
      };
    } catch {
      // Bulk failed - fall back to individual creates
      console.log(
        "[set_vacation] Bulk create failed, falling back to individual creates",
      );
    }
  }

  // Individual creates (single or fallback)
  const results: Array<{ name: string; success: boolean; error?: string }> =
    [];

  for (const v of ecobeeVacations) {
    try {
      await api.createVacation(thermostatId, v);
      results.push({ name: v.name, success: true });
    } catch (err) {
      results.push({
        name: v.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cache.invalidate(thermostatId);

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  let text = `Created ${succeeded.length}/${results.length} vacation events.`;
  if (succeeded.length > 0) {
    text += `\n\nCreated:\n${succeeded.map((r) => `  - ${r.name}`).join("\n")}`;
  }
  if (failed.length > 0) {
    text += `\n\nFailed:\n${failed.map((r) => `  - ${r.name}: ${r.error}`).join("\n")}`;
  }

  return {
    content: [{ type: "text" as const, text }],
    ...(failed.length > 0 && { isError: true }),
  };
}

async function handleDelete(
  thermostatId: string,
  vacationName: string | undefined,
  api: EcobeeApiClient,
  cache: EcobeeCache,
) {
  if (!vacationName) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: vacationName is required for delete action.",
        },
      ],
      isError: true,
    };
  }

  await api.deleteVacation(thermostatId, vacationName);
  cache.invalidate(thermostatId);

  return {
    content: [
      {
        type: "text" as const,
        text: `Vacation "${vacationName}" deleted from thermostat ${thermostatId}.`,
      },
    ],
  };
}

/** Generate a vacation name that fits Ecobee's 12-char limit. e.g. "Feb07-Feb09" */
function generateVacationName(startDate: string, endDate: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const s = new Date(startDate + "T00:00:00");
  const e = new Date(endDate + "T00:00:00");
  const sm = months[s.getMonth()];
  const sd = String(s.getDate()).padStart(2, "0");
  const em = months[e.getMonth()];
  const ed = String(e.getDate()).padStart(2, "0");
  return `${sm}${sd}-${em}${ed}`; // e.g. "Feb07-Feb09" = 11 chars
}

function makeUniqueName(baseName: string, existing: Set<string>): string {
  let counter = 2;
  // Keep within 12 chars: truncate base if needed to fit suffix
  let candidate = `${baseName}${counter}`;
  while (existing.has(candidate)) {
    counter++;
    candidate = `${baseName}${counter}`;
  }
  return candidate.slice(0, 12);
}

function normalizeTime(time?: string): string {
  if (!time) return "00:00:00";
  // Accept HH:mm or HH:mm:ss
  const parts = time.split(":");
  if (parts.length === 2) return `${time}:00`;
  return time;
}
