import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

export function registerResumeSchedule(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "resume_schedule",
    {
      description:
        "Cancel any active hold and resume the normal thermostat program schedule.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        resumeAll: z
          .boolean()
          .default(false)
          .describe("If true, removes all events including vacation holds. Default removes only the top event."),
      },
    },
    async ({ thermostatId, resumeAll }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.resumeProgram(id, resumeAll);
      cache.invalidate(id);

      return {
        content: [
          {
            type: "text" as const,
            text: `Schedule resumed on thermostat ${id}${resumeAll ? " (all events cleared)" : ""}.`,
          },
        ],
      };
    },
  );
}
