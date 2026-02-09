import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp } from "../ecobee/types.js";

export function registerSetTemperature(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "set_temperature",
    {
      description:
        "Set a temperature hold on the thermostat. Specify heat and/or cool set points in degrees F.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        heatTemp: z
          .number()
          .optional()
          .describe("Heat set point in degrees F (e.g., 68)"),
        coolTemp: z
          .number()
          .optional()
          .describe("Cool set point in degrees F (e.g., 76)"),
        holdType: z
          .enum(["nextTransition", "indefinite"])
          .default("nextTransition")
          .describe("How long to hold: until next schedule transition or indefinitely"),
      },
    },
    async ({ thermostatId, heatTemp, coolTemp, holdType }) => {
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

      // Resolve thermostat ID if not provided
      const id = await resolveId(thermostatId, api, cache);

      await api.setHold(id, {
        holdType,
        ...(heatTemp !== undefined && {
          heatHoldTemp: toEcobeeTemp(heatTemp),
        }),
        ...(coolTemp !== undefined && {
          coolHoldTemp: toEcobeeTemp(coolTemp),
        }),
      });

      cache.invalidate(id);

      return {
        content: [
          {
            type: "text" as const,
            text: `Temperature hold set on ${id}: ${heatTemp !== undefined ? `heat=${heatTemp}°F` : ""}${heatTemp !== undefined && coolTemp !== undefined ? ", " : ""}${coolTemp !== undefined ? `cool=${coolTemp}°F` : ""} (${holdType})`,
          },
        ],
      };
    },
  );
}

/** Helper to resolve thermostat ID, defaulting to first registered. */
export async function resolveId(
  thermostatId: string | undefined,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): Promise<string> {
  if (thermostatId) return thermostatId;

  const thermostats = await cache.getOrFetch("all:list", async () => {
    return api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
      includeRuntime: true,
    });
  });

  if (thermostats.length === 0) {
    throw new Error("No thermostats found");
  }

  return thermostats[0].identifier;
}
