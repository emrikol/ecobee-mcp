import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

export function registerSetHold(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "set_hold",
    {
      description:
        'Hold a comfort profile (e.g., "away", "home", "sleep") or custom temperatures. Use climateRef for named profiles, or heatTemp/coolTemp for custom holds.',
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        climateRef: z
          .string()
          .optional()
          .describe('Climate ref to hold (e.g., "away", "home", "sleep")'),
        heatTemp: z
          .number()
          .optional()
          .describe("Heat set point in degrees F (used with custom hold)"),
        coolTemp: z
          .number()
          .optional()
          .describe("Cool set point in degrees F (used with custom hold)"),
        holdType: z
          .enum(["nextTransition", "indefinite"])
          .default("nextTransition")
          .describe("How long to hold"),
      },
    },
    async ({ thermostatId, climateRef, heatTemp, coolTemp, holdType }) => {
      if (
        !climateRef &&
        heatTemp === undefined &&
        coolTemp === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Specify either climateRef or at least one of heatTemp/coolTemp.",
            },
          ],
          isError: true,
        };
      }

      const id = await resolveId(thermostatId, api, cache);

      await api.setHold(id, {
        holdType,
        ...(climateRef && { holdClimateRef: climateRef }),
        ...(heatTemp !== undefined && {
          heatHoldTemp: toEcobeeTemp(heatTemp),
        }),
        ...(coolTemp !== undefined && {
          coolHoldTemp: toEcobeeTemp(coolTemp),
        }),
      });

      cache.invalidate(id);

      const desc = climateRef
        ? `climate "${climateRef}"`
        : `${heatTemp !== undefined ? `heat=${heatTemp}°F` : ""}${heatTemp !== undefined && coolTemp !== undefined ? ", " : ""}${coolTemp !== undefined ? `cool=${coolTemp}°F` : ""}`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Hold set on ${id}: ${desc} (${holdType})`,
          },
        ],
      };
    },
  );
}
