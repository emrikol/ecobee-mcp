import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";

export function registerGetThermostatStatus(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_thermostat_status",
    {
      description:
        "Get current thermostat status including temperature, humidity, HVAC mode, set points, running equipment, and any active holds.",
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
        `${id}:status`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeRuntime: true,
            includeSettings: true,
            includeEvents: true,
            includeEquipmentStatus: true,
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

      const t = thermostatId
        ? thermostats[0]
        : thermostats[0];

      const activeHold = t.events?.find(
        (e) => e.running && e.type === "hold",
      );
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
        desiredHeat: t.runtime
          ? fromEcobeeTemp(t.runtime.desiredHeat)
          : null,
        desiredCool: t.runtime
          ? fromEcobeeTemp(t.runtime.desiredCool)
          : null,
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
