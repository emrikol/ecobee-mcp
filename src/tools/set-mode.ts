import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

export function registerSetMode(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "set_hvac_mode",
    {
      description:
        "Change the thermostat's HVAC mode (heat, cool, auto, off, or auxHeatOnly).",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        mode: z
          .enum(["heat", "cool", "auto", "off", "auxHeatOnly"])
          .describe("The HVAC mode to set"),
      },
    },
    async ({ thermostatId, mode }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.setHvacMode(id, mode);
      cache.invalidate(id);

      return {
        content: [
          {
            type: "text" as const,
            text: `HVAC mode set to "${mode}" on thermostat ${id}.`,
          },
        ],
      };
    },
  );
}
