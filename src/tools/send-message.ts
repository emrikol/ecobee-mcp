import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

export function registerSendMessage(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "send_message",
    {
      description:
        "Display a text message on the thermostat screen. Message is truncated to 500 characters.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        text: z
          .string()
          .max(500)
          .describe("Message text to display on the thermostat (max 500 characters)"),
      },
    },
    async ({ thermostatId, text }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.sendMessage(id, text);

      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to thermostat ${id}: "${text}"`,
          },
        ],
      };
    },
  );
}
