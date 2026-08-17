import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import {
  boundedString,
  finiteNumber,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const eventSchema = z.object({
  type: boundedString(64),
  heatTemp: finiteNumber,
  coolTemp: finiteNumber,
  endDate: boundedString(10),
  endTime: boundedString(8),
});

const outputSchema = z.object({
  thermostat: z
    .object({
      id: boundedString(64),
      name: boundedString(128),
      thermostatTime: boundedString(32),
      connected: z.boolean(),
      temperature: finiteNumber.nullable(),
      humidity: finiteNumber.nullable(),
      hvacMode: boundedString(32),
      desiredHeat: finiteNumber.nullable(),
      desiredCool: finiteNumber.nullable(),
      equipmentStatus: boundedString(512),
      activeHold: eventSchema.nullable(),
      activeVacation: eventSchema
        .omit({ type: true })
        .extend({ name: boundedString(64) })
        .nullable(),
    })
    .nullable(),
});

export function registerGetThermostatStatus(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_thermostat_status",
    {
      description:
        "Get current thermostat status including temperature, humidity, HVAC mode, set points, running equipment, and any active holds.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(`${id}:status`, async () => {
        return api.getThermostats({
          selectionType: thermostatId ? "thermostats" : "registered",
          selectionMatch: thermostatId ?? "",
          includeRuntime: true,
          includeSettings: true,
          includeEvents: true,
          includeEquipmentStatus: true,
        });
      });

      if (thermostats.length === 0) {
        return structuredResult(
          outputSchema,
          { thermostat: null },
          "No thermostats found.",
        );
      }

      const t = thermostats[0];

      const activeHold = t.events?.find((e) => e.running && e.type === "hold");
      const activeVacation = t.events?.find(
        (e) => e.running && e.type === "vacation",
      );

      const result = {
        id: t.identifier,
        name: t.name,
        thermostatTime: t.thermostatTime,
        connected: t.runtime?.connected ?? false,
        temperature: t.runtime
          ? fromEcobeeTemp(t.runtime.actualTemperature)
          : null,
        humidity: t.runtime?.actualHumidity ?? null,
        hvacMode: t.settings?.hvacMode ?? "unknown",
        desiredHeat: t.runtime ? fromEcobeeTemp(t.runtime.desiredHeat) : null,
        desiredCool: t.runtime ? fromEcobeeTemp(t.runtime.desiredCool) : null,
        equipmentStatus: t.equipmentStatus ?? "",
        activeHold: activeHold
          ? {
              type: activeHold.holdClimateRef || "temperature",
              heatTemp: fromEcobeeTemp(activeHold.heatHoldTemp),
              coolTemp: fromEcobeeTemp(activeHold.coolHoldTemp),
              endDate: activeHold.endDate,
              endTime: activeHold.endTime,
            }
          : null,
        activeVacation: activeVacation
          ? {
              name: activeVacation.name,
              heatTemp: fromEcobeeTemp(activeVacation.heatHoldTemp),
              coolTemp: fromEcobeeTemp(activeVacation.coolHoldTemp),
              endDate: activeVacation.endDate,
              endTime: activeVacation.endTime,
            }
          : null,
      };

      return structuredResult(outputSchema, { thermostat: result }, result);
    },
  );
}
