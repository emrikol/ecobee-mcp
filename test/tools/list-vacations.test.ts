import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerListVacations } from "../../src/tools/list-vacations.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("list_vacations tool", () => {
  it("should list vacation events with converted temps", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          events: [
            {
              type: "vacation",
              name: "Feb07-Feb09",
              running: true,
              startDate: "2026-02-07",
              startTime: "15:00:00",
              endDate: "2026-02-09",
              endTime: "14:30:00",
              heatHoldTemp: 650,
              coolHoldTemp: 780,
              fan: "auto",
              isOccupied: false,
              isCoolOff: false,
              isHeatOff: false,
              vent: "",
              ventilatorMinOnTime: 0,
              isOptional: true,
              isTemperatureRelative: false,
              isTemperatureAbsolute: true,
              dutyCyclePercentage: 100,
              fanMinOnTime: 0,
              occupiedSensorActive: false,
              unoccupiedSensorActive: false,
              drRampUpTemp: 0,
              drRampUpTime: 0,
              linkRef: "",
              holdClimateRef: "",
            },
            {
              type: "hold",
              name: "not-a-vacation",
              running: false,
            },
          ],
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerListVacations(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_vacations"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as Array<{
      name: string;
      heatTemp: number;
      coolTemp: number;
    }>;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Feb07-Feb09");
    expect(data[0].heatTemp).toBe(65);
    expect(data[0].coolTemp).toBe(78);
  });

  it("should handle no thermostats found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerListVacations(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_vacations"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("should report no vacations", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi
        .fn()
        .mockResolvedValue([{ identifier: "123", name: "Main", events: [] }]),
    } as unknown as EcobeeApiClient;

    registerListVacations(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_vacations"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No vacation");
  });
});
