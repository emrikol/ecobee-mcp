import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function registerGetSchedule(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_schedule",
    {
      description:
        "Get the thermostat's program schedule, comfort profiles (home/away/sleep), and current climate.",
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
        `${id}:schedule`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeProgram: true,
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

      const program = thermostats[0].program;
      if (!program) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No program data available.",
            },
          ],
        };
      }

      const result = {
        currentClimate: program.currentClimateRef,
        climates: program.climates.map((c) => ({
          name: c.name,
          ref: c.climateRef,
          type: c.type,
          heatTemp: fromEcobeeTemp(c.heatTemp),
          coolTemp: fromEcobeeTemp(c.coolTemp),
          isOccupied: c.isOccupied,
        })),
        schedule: program.schedule.map((day, i) => ({
          day: DAY_NAMES[i],
          periods: day,
        })),
      };

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
