import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp, fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

export function registerUpdateComfortProfile(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "update_comfort_profile",
    {
      description:
        'Permanently update the temperature set points for a comfort profile (e.g., "home", "away", "sleep"). This changes the schedule defaults, not a temporary hold.',
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        climateRef: z
          .string()
          .describe('The climate ref to update (e.g., "home", "away", "sleep")'),
        heatTemp: z
          .number()
          .optional()
          .describe("New heat set point in degrees F"),
        coolTemp: z
          .number()
          .optional()
          .describe("New cool set point in degrees F"),
      },
    },
    async ({ thermostatId, climateRef, heatTemp, coolTemp }) => {
      if (heatTemp === undefined && coolTemp === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Must specify at least one of heatTemp or coolTemp.",
            },
          ],
          isError: true,
        };
      }

      const id = await resolveId(thermostatId, api, cache);

      // Fetch current to show before/after
      const before = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeProgram: true,
      });

      const climate = before[0]?.program?.climates.find(
        (c) => c.climateRef === climateRef,
      );

      if (!climate) {
        /* v8 ignore next 3 */
        const available =
          before[0]?.program?.climates.map((c) => c.climateRef).join(", ") ??
          "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Climate "${climateRef}" not found. Available: ${available}`,
            },
          ],
          isError: true,
        };
      }

      const oldHeat = fromEcobeeTemp(climate.heatTemp);
      const oldCool = fromEcobeeTemp(climate.coolTemp);

      await api.updateComfortProfile(id, climateRef, {
        ...(heatTemp !== undefined && { heatTemp: toEcobeeTemp(heatTemp) }),
        ...(coolTemp !== undefined && { coolTemp: toEcobeeTemp(coolTemp) }),
      });

      cache.invalidate(id);

      const changes: string[] = [];
      if (heatTemp !== undefined) changes.push(`heat: ${oldHeat}°F → ${heatTemp}°F`);
      if (coolTemp !== undefined) changes.push(`cool: ${oldCool}°F → ${coolTemp}°F`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated "${climateRef}" profile on ${id}: ${changes.join(", ")}`,
          },
        ],
      };
    },
  );
}
