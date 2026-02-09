import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

export function registerGetUtilityInfo(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_utility_info",
    {
      description:
        "Get utility company information associated with the thermostat.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe(
            "Thermostat ID. Omit to use the first registered thermostat.",
          ),
      },
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeUtility: true,
      });

      if (thermostats.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No thermostat found." },
          ],
          isError: true,
        };
      }

      const t = thermostats[0];
      const utility = t.utility;

      if (!utility) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No utility information available for this thermostat.",
            },
          ],
        };
      }

      const result = {
        thermostat: t.name,
        utility,
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
