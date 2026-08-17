import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  MAX_EVENTS,
  mutationAnnotations,
  optionalThermostatIdSchema,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const alertSchema = z.object({
  acknowledgeRef: boundedString(128),
  date: boundedString(10),
  time: boundedString(8),
  severity: boundedString(32),
  text: boundedString(2_048),
  alertType: boundedString(64),
  notificationType: boundedString(64),
  acknowledgement: boundedString(32),
});

const readOutputSchema = z.object({
  thermostatId: boundedString(64).nullable(),
  alerts: z.array(alertSchema).max(MAX_EVENTS),
});

const acknowledgeInputSchema = z.object({
  thermostatId: optionalThermostatIdSchema,
  acknowledgeRef: boundedString(128).describe(
    "The acknowledgeRef from the alert to acknowledge",
  ),
  ackType: z
    .enum(["accept", "decline", "defer", "unacknowledged"])
    .describe("How to respond to the alert"),
});

const mutationOutputSchema = z.object({
  thermostatId: boundedString(64),
  requestedChange: z.object({
    acknowledgeRef: boundedString(128),
    ackType: z.enum(["accept", "decline", "defer", "unacknowledged"]),
  }),
  resultingState: z.object({ delivery: z.literal("accepted") }),
});

export function registerGetAlerts(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_alerts",
    {
      description:
        "Get active alerts for a thermostat (filter reminders, maintenance, temperature alerts, etc.).",
      inputSchema: optionalThermostatInputSchema,
      outputSchema: readOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(`${id}:alerts`, async () => {
        return api.getThermostats({
          selectionType: thermostatId ? "thermostats" : "registered",
          selectionMatch: thermostatId ?? "",
          includeAlerts: true,
        });
      });

      if (thermostats.length === 0) {
        return structuredResult(
          readOutputSchema,
          {
            thermostatId: null,
            alerts: [],
          },
          "No thermostats found.",
        );
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

      return structuredResult(
        readOutputSchema,
        {
          thermostatId: thermostats[0].identifier,
          alerts: result,
        },
        result.length > 0 ? result : "No active alerts.",
      );
    },
  );
}

export function registerAcknowledgeAlert(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "acknowledge_alert",
    {
      description:
        "Acknowledge (accept, decline, or defer) an alert on the thermostat.",
      inputSchema: acknowledgeInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, acknowledgeRef, ackType }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.acknowledgeAlert(id, acknowledgeRef, ackType);
      cache.invalidate(id);

      return structuredResult(
        mutationOutputSchema,
        {
          thermostatId: id,
          requestedChange: { acknowledgeRef, ackType },
          resultingState: { delivery: "accepted" },
        },
        `Alert acknowledged (${ackType}) on thermostat ${id}.`,
      );
    },
  );
}
