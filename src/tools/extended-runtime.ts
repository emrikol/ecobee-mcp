import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  finiteNumber,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
  toolError,
} from "./contracts.js";

const equipmentSchema = z.object({
  heatPump1: finiteNumber,
  heatPump2: finiteNumber,
  auxHeat1: finiteNumber,
  auxHeat2: finiteNumber,
  auxHeat3: finiteNumber,
  cool1: finiteNumber,
  cool2: finiteNumber,
  fan: finiteNumber,
  humidifier: finiteNumber,
  dehumidifier: finiteNumber,
});

const outputSchema = z.object({
  thermostatId: boundedString(64),
  thermostatName: boundedString(128),
  lastReading: boundedString(32).nullable(),
  readings: z
    .array(
      z.object({
        time: boundedString(64),
        actualTemp: finiteNumber,
        actualHumidity: finiteNumber,
        desiredHeat: finiteNumber,
        desiredCool: finiteNumber,
        equipment: equipmentSchema,
      }),
    )
    .max(12),
});

export function registerGetExtendedRuntime(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_extended_runtime",
    {
      description:
        "Get near-real-time 5-minute interval runtime data (last ~15 minutes). Shows actual temps, setpoints, humidity, and equipment runtime in seconds. Updated every 15 minutes by the thermostat.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeExtendedRuntime: true,
      });

      if (thermostats.length === 0) {
        return toolError("No thermostat found.");
      }

      const t = thermostats[0];
      const ext = t.extendedRuntime;

      if (!ext) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: t.identifier,
            thermostatName: t.name,
            lastReading: null,
            readings: [],
          },
          "No extended runtime data available.",
        );
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

      return structuredResult(
        outputSchema,
        {
          thermostatId: t.identifier,
          thermostatName: t.name,
          lastReading: ext.lastReadingTimestamp,
          readings,
        },
        {
          thermostat: t.name,
          lastReading: ext.lastReadingTimestamp,
          readings,
        },
      );
    },
  );
}
