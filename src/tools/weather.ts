import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";

export function registerGetWeather(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_weather",
    {
      description:
        "Get weather conditions and forecast from the thermostat's weather station.",
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
        `${id}:weather`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeWeather: true,
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

      const weather = thermostats[0].weather;
      if (!weather) {
        return {
          content: [
            { type: "text" as const, text: "No weather data available." },
          ],
        };
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
