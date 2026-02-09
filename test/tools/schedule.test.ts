import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetSchedule } from "../../src/tools/schedule.js";
import { createServer, getTools, mockApiBase, parseResult, signal } from "./helpers.js";

describe("get_schedule tool", () => {
  it("should return schedule with climates", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          program: {
            currentClimateRef: "home",
            climates: [
              {
                name: "Home",
                climateRef: "home",
                isOccupied: true,
                isOptimized: false,
                coolFan: "auto",
                heatFan: "auto",
                vent: "",
                ventilatorMinOnTime: 0,
                owner: "system",
                type: "program",
                colour: 0,
                coolTemp: 760,
                heatTemp: 700,
              },
              {
                name: "Away",
                climateRef: "away",
                isOccupied: false,
                isOptimized: false,
                coolFan: "auto",
                heatFan: "auto",
                vent: "",
                ventilatorMinOnTime: 0,
                owner: "system",
                type: "program",
                colour: 0,
                coolTemp: 780,
                heatTemp: 600,
              },
            ],
            schedule: [
              ["home", "home", "away", "away", "home", "home"],
            ],
          },
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetSchedule(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_schedule"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      currentClimate: string;
      climates: Array<{ name: string; heatTemp: number; coolTemp: number }>;
    };
    expect(data.currentClimate).toBe("home");
    expect(data.climates).toHaveLength(2);
    expect(data.climates[0].heatTemp).toBe(70);
    expect(data.climates[0].coolTemp).toBe(76);
  });

  it("should handle no thermostats found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetSchedule(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_schedule"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("should handle missing program data", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        { identifier: "123", name: "Main" },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetSchedule(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_schedule"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No program data");
  });
});
