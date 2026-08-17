import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetWeather } from "../../src/tools/weather.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_weather tool", () => {
  it("should return weather with converted temps", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          weather: {
            timestamp: "2026-02-07 12:00:00",
            weatherStation: "KORD",
            forecasts: [
              {
                weatherSymbol: 0,
                dateTime: "2026-02-07 12:00:00",
                condition: "Partly Cloudy",
                temperature: 320,
                pressure: 30,
                relativeHumidity: 55,
                dewpoint: 200,
                visibility: 10,
                windSpeed: 12,
                windGust: 0,
                windDirection: "NW",
                windBearing: 315,
                pop: 10,
                tempHigh: 380,
                tempLow: 250,
                sky: 2,
              },
            ],
          },
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetWeather(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_weather"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = (
      parseResult(result) as {
        weather: {
          station: string;
          forecasts: Array<{ condition: string; temperature: number }>;
        };
      }
    ).weather;
    expect(data.station).toBe("KORD");
    expect(data.forecasts[0].condition).toBe("Partly Cloudy");
    expect(data.forecasts[0].temperature).toBe(32);
  });

  it("should handle no thermostats found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetWeather(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_weather"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("should handle missing weather", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi
        .fn()
        .mockResolvedValue([{ identifier: "123", name: "Main" }]),
    } as unknown as EcobeeApiClient;

    registerGetWeather(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_weather"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No weather");
  });
});
