import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";

export function registerListGroups(
  server: McpServer,
  api: EcobeeApiClient,
  _cache: EcobeeCache,
): void {
  server.registerTool(
    "list_groups",
    {
      description:
        "List all thermostat groups. Groups synchronize settings across multiple thermostats.",
      inputSchema: {},
    },
    async () => {
      const groups = await api.getGroups();

      if (groups.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No thermostat groups configured." },
          ],
        };
      }

      const result = groups.map((g) => {
        const synced = Object.entries(g)
          .filter(
            ([k, v]) => k.startsWith("synchronize") && v === true,
          )
          .map(([k]) => k.replace("synchronize", ""));

        return {
          groupRef: g.groupRef,
          groupName: g.groupName,
          thermostats: g.thermostats,
          synchronizing: synced.length > 0 ? synced : "none",
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

export function registerManageGroup(
  server: McpServer,
  api: EcobeeApiClient,
  _cache: EcobeeCache,
): void {
  server.registerTool(
    "manage_group",
    {
      description:
        "Create, update, or delete a thermostat group. Groups synchronize settings across thermostats. To delete, send an empty thermostats array.",
      inputSchema: {
        groupRef: z
          .string()
          .optional()
          .describe(
            "Group reference ID. Omit to create a new group. Required for update/delete.",
          ),
        groupName: z
          .string()
          .optional()
          .describe("Group name. Required when creating."),
        thermostats: z
          .array(z.string())
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
      },
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

      const isDelete =
        args.thermostats && args.thermostats.length === 0;

      const result = await api.updateGroups([group]);

      if (isDelete) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Group "${args.groupName ?? args.groupRef}" deleted.`,
            },
          ],
        };
      }

      const action = args.groupRef ? "Updated" : "Created";
      return {
        content: [
          {
            type: "text" as const,
            text: `${action} group:\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    },
  );
}
