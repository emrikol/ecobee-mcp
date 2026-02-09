import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

export function registerGetDemandResponse(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_demand_response",
    {
      description:
        "List demand response (DR) events from your utility's eco+ program. Shows active and upcoming DR events with their temperature adjustments and duty cycle settings.",
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
        includeEvents: true,
        includeSettings: true,
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
      const drEvents = (t.events ?? []).filter(
        (e) => e.type === "demandResponse",
      );

      const drAccept = t.settings?.drAccept ?? "unknown";

      if (drEvents.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No demand response events. DR acceptance setting: ${drAccept}`,
            },
          ],
        };
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

      const result = {
        thermostat: t.name,
        drAcceptSetting: drAccept,
        events,
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
