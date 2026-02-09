import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

export function registerGetExtendedRuntime(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_extended_runtime",
    {
      description:
        "Get near-real-time 5-minute interval runtime data (last ~15 minutes). Shows actual temps, setpoints, humidity, and equipment runtime in seconds. Updated every 15 minutes by the thermostat.",
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
        includeExtendedRuntime: true,
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
      const ext = t.extendedRuntime;

      if (!ext) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No extended runtime data available.",
            },
          ],
          isError: true,
        };
      }

      // Convert interval numbers to timestamps
      const readings = ext.actualTemperature.map((_, i) => {
        const interval = ext.runtimeInterval - 2 + i;
        const minutes = interval * 5;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const time = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;

        return {
          time: `${ext.runtimeDate} ${time} UTC`,
          actualTemp: fromEcobeeTemp(ext.actualTemperature[i]),
          actualHumidity: ext.actualHumidity[i],
          desiredHeat: fromEcobeeTemp(ext.desiredHeat[i]),
          desiredCool: fromEcobeeTemp(ext.desiredCool[i]),
          equipment: {
            heatPump1: ext.heatPump1[i],
            heatPump2: ext.heatPump2[i],
            auxHeat1: ext.auxHeat1[i],
            auxHeat2: ext.auxHeat2[i],
            auxHeat3: ext.auxHeat3[i],
            cool1: ext.cool1[i],
            cool2: ext.cool2[i],
            fan: ext.fan[i],
            humidifier: ext.humidifier[i],
            dehumidifier: ext.dehumidifier[i],
          },
        };
      });

      const result = {
        thermostat: t.name,
        lastReading: ext.lastReadingTimestamp,
        readings,
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
