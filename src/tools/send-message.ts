import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  mutationAnnotations,
  optionalThermostatIdSchema,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const outputSchema = z.object({
  thermostatId: boundedString(64),
  requestedChange: z.object({
    messageLength: z.number().int().min(0).max(500),
    messageSha256: boundedString(64),
  }),
  resultingState: z.object({ delivery: z.literal("accepted") }),
});

export function registerSendMessage(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "send_message",
    {
      description:
        "Display a text message on the thermostat screen. Messages are limited to 500 characters.",
      inputSchema: z.object({
        thermostatId: optionalThermostatIdSchema,
        text: boundedString(500)
          .min(1)
          .max(500)
          .describe(
            "Message text to display on the thermostat (max 500 characters)",
          ),
      }),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, text }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.sendMessage(id, text);

      // Deliberately do not echo the message; callers sometimes place secrets
      // in free-form text and MCP results must never reflect them.
      return structuredResult(
        outputSchema,
        {
          thermostatId: id,
          requestedChange: {
            messageLength: text.length,
            messageSha256: createHash("sha256").update(text).digest("hex"),
          },
          resultingState: { delivery: "accepted" },
        },
        `Message sent to thermostat ${id}.`,
      );
    },
  );
}
