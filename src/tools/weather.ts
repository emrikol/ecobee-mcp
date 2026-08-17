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

const outputSchema = z.object({
  thermostatId: boundedString(64).nullable(),
  weather: z
    .object({
      station: boundedString(128),
      timestamp: boundedString(32),
      forecasts: z
        .array(
          z.object({
            dateTime: boundedString(32),
            condition: boundedString(128),
            temperature: finiteNumber,
            humidity: finiteNumber,
            windSpeed: finiteNumber,
            windDirection: boundedString(32),
            pop: finiteNumber,
            tempHigh: finiteNumber,
            tempLow: finiteNumber,
          }),
        )
        .max(64),
    })
    .nullable(),
});

export function registerGetWeather(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_weather",
    {
      description:
        "Get weather conditions and forecast from the thermostat's weather station.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(`${id}:weather`, async () => {
        return api.getThermostats({
          selectionType: thermostatId ? "thermostats" : "registered",
          selectionMatch: thermostatId ?? "",
          includeWeather: true,
        });
      });

      if (thermostats.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: null,
            weather: null,
          },
          "No thermostats found.",
        );
      }

      const weather = thermostats[0].weather;
      if (!weather) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: thermostats[0].identifier,
            weather: null,
          },
          "No weather data available.",
        );
      }

      const result = {
        station: weather.weatherStation,
        timestamp: weather.timestamp,
        forecasts: weather.forecasts.map((f) => ({
          dateTime: f.dateTime,
          condition: f.condition,
          temperature: fromEcobeeTemp(f.temperature),
          humidity: f.relativeHumidity,
          windSpeed: f.windSpeed,
          windDirection: f.windDirection,
          pop: f.pop,
          tempHigh: fromEcobeeTemp(f.tempHigh),
          tempLow: fromEcobeeTemp(f.tempLow),
        })),
      };

      return structuredResult(
        outputSchema,
        {
          thermostatId: thermostats[0].identifier,
          weather: result,
        },
        result,
      );
    },
  );
}
