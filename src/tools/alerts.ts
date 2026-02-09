import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";

export function registerGetAlerts(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_alerts",
    {
      description:
        "Get active alerts for a thermostat (filter reminders, maintenance, temperature alerts, etc.).",
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
        `${id}:alerts`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeAlerts: true,
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

      const alerts = thermostats[0].alerts ?? [];

      const result = alerts.map((a) => ({
        acknowledgeRef: a.acknowledgeRef,
        date: a.date,
        time: a.time,
        severity: a.severity,
        text: a.text,
        alertType: a.alertType,
        notificationType: a.notificationType,
        acknowledgement: a.acknowledgement,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              result.length > 0
                ? JSON.stringify(result, null, 2)
                : "No active alerts.",
          },
        ],
      };
    },
  );
}

export function registerAcknowledgeAlert(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "acknowledge_alert",
    {
      description:
        "Acknowledge (accept, decline, or defer) an alert on the thermostat.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
        acknowledgeRef: z
          .string()
          .describe("The acknowledgeRef from the alert to acknowledge"),
        ackType: z
          .enum(["accept", "decline", "defer", "unacknowledged"])
          .describe("How to respond to the alert"),
      },
    },
    async ({ thermostatId, acknowledgeRef, ackType }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.acknowledgeAlert(id, acknowledgeRef, ackType);
      cache.invalidate(id);

      return {
        content: [
          {
            type: "text" as const,
            text: `Alert acknowledged (${ackType}) on thermostat ${id}.`,
          },
        ],
      };
    },
  );
}
