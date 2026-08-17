import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import {
  boundedString,
  destructiveMutationAnnotations,
  MAX_THERMOSTATS,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const syncNameSchema = z.enum([
  "Alerts",
  "SystemMode",
  "Schedule",
  "QuickSave",
  "Reminders",
  "ContractorInfo",
  "UserPreferences",
  "UtilityInfo",
  "Location",
  "Reset",
  "Vacation",
]);

const groupResultSchema = z.object({
  groupRef: boundedString(128),
  groupName: boundedString(128),
  thermostats: z.array(boundedString(64)).max(MAX_THERMOSTATS),
  synchronizing: z.array(syncNameSchema).max(11),
});

const listOutputSchema = z.object({
  groups: z.array(groupResultSchema).max(128),
});

export function registerListGroups(
  server: McpServer,
  api: EcobeeApiClient,
  _cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "list_groups",
    {
      description:
        "List all thermostat groups. Groups synchronize settings across multiple thermostats.",
      inputSchema: z.object({}),
      outputSchema: listOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => {
      const groups = await api.getGroups();

      if (groups.length === 0) {
        return structuredResult(
          listOutputSchema,
          { groups: [] },
          "No thermostat groups configured.",
        );
      }

      const result = groups.map((g) => {
        return {
          groupRef: g.groupRef,
          groupName: g.groupName,
          thermostats: g.thermostats,
          synchronizing: synchronizedSettings(g),
        };
      });

      return structuredResult(listOutputSchema, { groups: result }, result);
    },
  );
}

const syncFlags = [
  "synchronizeAlerts",
  "synchronizeSystemMode",
  "synchronizeSchedule",
  "synchronizeQuickSave",
  "synchronizeReminders",
  "synchronizeContractorInfo",
  "synchronizeUserPreferences",
  "synchronizeUtilityInfo",
  "synchronizeLocation",
  "synchronizeReset",
  "synchronizeVacation",
] as const;

const syncLabels = {
  synchronizeAlerts: "Alerts",
  synchronizeSystemMode: "SystemMode",
  synchronizeSchedule: "Schedule",
  synchronizeQuickSave: "QuickSave",
  synchronizeReminders: "Reminders",
  synchronizeContractorInfo: "ContractorInfo",
  synchronizeUserPreferences: "UserPreferences",
  synchronizeUtilityInfo: "UtilityInfo",
  synchronizeLocation: "Location",
  synchronizeReset: "Reset",
  synchronizeVacation: "Vacation",
} as const;

function synchronizedSettings(
  group: Partial<Record<(typeof syncFlags)[number], boolean>>,
): Array<z.output<typeof syncNameSchema>> {
  return syncFlags
    .filter((flag) => group[flag] === true)
    .map((flag) => syncLabels[flag]);
}

const manageInputSchema = z.object({
  groupRef: boundedString(128)
    .optional()
    .describe(
      "Group reference ID. Omit to create a new group. Required for update/delete.",
    ),
  groupName: boundedString(128)
    .optional()
    .describe("Group name. Required when creating."),
  thermostats: z
    .array(boundedString(64))
    .max(MAX_THERMOSTATS)
    .optional()
    .describe(
      "Thermostat IDs in the group. Send empty array to delete the group.",
    ),
  synchronizeAlerts: z.boolean().optional(),
  synchronizeSystemMode: z.boolean().optional(),
  synchronizeSchedule: z.boolean().optional(),
  synchronizeQuickSave: z.boolean().optional(),
  synchronizeReminders: z.boolean().optional(),
  synchronizeContractorInfo: z.boolean().optional(),
  synchronizeUserPreferences: z.boolean().optional(),
  synchronizeUtilityInfo: z.boolean().optional(),
  synchronizeLocation: z.boolean().optional(),
  synchronizeReset: z.boolean().optional(),
  synchronizeVacation: z.boolean().optional(),
});

const requestedGroupSchema = manageInputSchema.omit({ groupRef: true });
const manageOutputSchema = z.object({
  target: z.object({ groupRef: boundedString(128).nullable() }),
  requestedChange: requestedGroupSchema,
  action: z.enum(["created", "updated", "deleted"]),
  resultingState: z.object({
    groups: z.array(groupResultSchema).max(128),
    verification: z.enum(["confirmed", "accepted"]),
  }),
});

export function registerManageGroup(
  server: McpServer,
  api: EcobeeApiClient,
  _cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "manage_group",
    {
      description:
        "Create, update, or delete a thermostat group. Groups synchronize settings across thermostats. To delete, send an empty thermostats array.",
      inputSchema: manageInputSchema,
      outputSchema: manageOutputSchema,
      annotations: destructiveMutationAnnotations,
    },
    async (args) => {
      if (!args.groupRef && !args.groupName) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: groupName is required when creating a new group.",
            },
          ],
          isError: true,
        };
      }

      const group: Record<string, unknown> = {};
      if (args.groupRef) group.groupRef = args.groupRef;
      if (args.groupName) group.groupName = args.groupName;
      if (args.thermostats) group.thermostats = args.thermostats;

      for (const flag of syncFlags) {
        if (args[flag] !== undefined) {
          group[flag] = args[flag];
        }
      }

      const isDelete = args.thermostats && args.thermostats.length === 0;

      const result = await api.updateGroups([group]);
      const mapped = result.map((g) => ({
        groupRef: g.groupRef,
        groupName: g.groupName,
        thermostats: g.thermostats,
        synchronizing: synchronizedSettings(g),
      }));
      const requestedChange = { ...args };
      delete requestedChange.groupRef;

      return structuredResult(
        manageOutputSchema,
        {
          target: { groupRef: args.groupRef ?? null },
          requestedChange,
          action: isDelete ? "deleted" : args.groupRef ? "updated" : "created",
          resultingState: {
            groups: mapped,
            verification:
              mapped.length > 0 || isDelete ? "confirmed" : "accepted",
          },
        },
        isDelete
          ? `Group "${args.groupName ?? args.groupRef}" deleted.`
          : `${args.groupRef ? "Updated" : "Created"} group:\n${JSON.stringify(mapped, null, 2)}`,
      );
    },
  );
}
