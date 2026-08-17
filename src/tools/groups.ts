import { type Infer, schema as s } from "../schema.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import {
  boundedString,
  destructiveMutationAnnotations,
  emptyInputSchema,
  MAX_THERMOSTATS,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const syncNameSchema = s.enum([
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

const groupResultSchema = s.object({
  groupRef: boundedString(128),
  groupName: boundedString(128),
  thermostats: s.array(boundedString(64)).max(MAX_THERMOSTATS),
  synchronizing: s.array(syncNameSchema).max(11),
});

const listOutputSchema = s.object({
  groups: s.array(groupResultSchema).max(128),
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
      inputSchema: emptyInputSchema,
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

      return structuredResult(listOutputSchema, { groups: result });
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
): Array<Infer<typeof syncNameSchema>> {
  return syncFlags
    .filter((flag) => group[flag] === true)
    .map((flag) => syncLabels[flag]);
}

const manageInputSchema = s.object({
  groupRef: boundedString(128)
    .optional()
    .describe(
      "Group reference ID. Omit to create a new group. Required for update/delete.",
    ),
  groupName: boundedString(128)
    .optional()
    .describe("Group name. Required when creating."),
  thermostats: s
    .array(boundedString(64))
    .max(MAX_THERMOSTATS)
    .optional()
    .describe(
      "Thermostat IDs in the group. Send empty array to delete the group.",
    ),
  synchronizeAlerts: s.boolean().optional(),
  synchronizeSystemMode: s.boolean().optional(),
  synchronizeSchedule: s.boolean().optional(),
  synchronizeQuickSave: s.boolean().optional(),
  synchronizeReminders: s.boolean().optional(),
  synchronizeContractorInfo: s.boolean().optional(),
  synchronizeUserPreferences: s.boolean().optional(),
  synchronizeUtilityInfo: s.boolean().optional(),
  synchronizeLocation: s.boolean().optional(),
  synchronizeReset: s.boolean().optional(),
  synchronizeVacation: s.boolean().optional(),
});

const requestedGroupSchema = manageInputSchema.omit({ groupRef: true });
const manageOutputSchema = s.object({
  target: s.object({ groupRef: boundedString(128).nullable() }),
  requestedChange: requestedGroupSchema,
  action: s.enum(["created", "updated", "deleted"]),
  resultingState: s.object({
    groups: s.array(groupResultSchema).max(128),
    verification: s.enum(["confirmed", "accepted"]),
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
