import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  finiteNumber,
  MAX_EVENTS,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
  toolError,
} from "./contracts.js";

const eventSchema = z.object({
  name: boundedString(128),
  running: z.boolean(),
  start: boundedString(32),
  end: boundedString(32),
  isOptional: z.boolean(),
  dutyCyclePercentage: finiteNumber,
  coolHoldTemp: finiteNumber,
  heatHoldTemp: finiteNumber,
  isTemperatureAbsolute: z.boolean(),
  isTemperatureRelative: z.boolean(),
});

const outputSchema = z.object({
  thermostatId: boundedString(64),
  thermostatName: boundedString(128),
  drAcceptSetting: boundedString(64),
  events: z.array(eventSchema).max(MAX_EVENTS),
});

export function registerGetDemandResponse(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_demand_response",
    {
      description:
        "List demand response (DR) events from your utility's eco+ program. Shows active and upcoming DR events with their temperature adjustments and duty cycle settings.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeEvents: true,
        includeSettings: true,
      });

      if (thermostats.length === 0) {
        return toolError("No thermostat found.");
      }

      const t = thermostats[0];
      const drEvents = (t.events ?? []).filter(
        (e) => e.type === "demandResponse",
      );

      const drAccept = t.settings?.drAccept ?? "unknown";

      if (drEvents.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: t.identifier,
            thermostatName: t.name,
            drAcceptSetting: drAccept,
            events: [],
          },
          `No demand response events. DR acceptance setting: ${drAccept}`,
        );
      }

      const events = drEvents.map((e) => ({
        name: e.name,
        running: e.running,
        start: `${e.startDate} ${e.startTime}`,
        end: `${e.endDate} ${e.endTime}`,
        isOptional: e.isOptional,
        dutyCyclePercentage: e.dutyCyclePercentage,
        coolHoldTemp: fromEcobeeTemp(e.coolHoldTemp),
        heatHoldTemp: fromEcobeeTemp(e.heatHoldTemp),
        isTemperatureAbsolute: e.isTemperatureAbsolute,
        isTemperatureRelative: e.isTemperatureRelative,
      }));

      return structuredResult(
        outputSchema,
        {
          thermostatId: t.identifier,
          thermostatName: t.name,
          drAcceptSetting: drAccept,
          events,
        },
        {
          thermostat: t.name,
          drAcceptSetting: drAccept,
          events,
        },
      );
    },
  );
}
