import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";

export function registerListVacations(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "list_vacations",
    {
      description:
        "List all scheduled vacation events for a thermostat, including dates, temperatures, and whether currently running.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
      },
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(
        `${id}:vacations`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeEvents: true,
          });
        },
      );

      if (thermostats.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No thermostats found." },
          ],
        };
      }

      const events = thermostats[0].events ?? [];
      const vacations = events
        .filter((e) => e.type === "vacation")
        .map((e) => ({
          name: e.name,
          running: e.running,
          startDate: e.startDate,
          startTime: e.startTime,
          endDate: e.endDate,
          endTime: e.endTime,
          heatTemp: fromEcobeeTemp(e.heatHoldTemp),
          coolTemp: fromEcobeeTemp(e.coolHoldTemp),
          fan: e.fan,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              vacations.length > 0
                ? JSON.stringify(vacations, null, 2)
                : "No vacation events scheduled.",
          },
        ],
      };
    },
  );
}
