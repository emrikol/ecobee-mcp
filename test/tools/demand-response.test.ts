import { describe, it, expect } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetDemandResponse } from "../../src/tools/demand-response.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_demand_response tool", () => {
  it("should return DR events", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          settings: { drAccept: "always" },
          events: [
            {
              type: "demandResponse",
              name: "DR-001",
              running: true,
              startDate: "2026-02-07",
              startTime: "14:00:00",
              endDate: "2026-02-07",
              endTime: "18:00:00",
              isOptional: true,
              dutyCyclePercentage: 50,
              coolHoldTemp: 780,
              heatHoldTemp: 650,
              isTemperatureAbsolute: true,
              isTemperatureRelative: false,
            },
            {
              type: "hold",
              name: "regular-hold",
              running: false,
            },
          ],
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetDemandResponse(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_demand_response"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      drAcceptSetting: string;
      events: Array<{ name: string; dutyCyclePercentage: number }>;
    };
    expect(data.drAcceptSetting).toBe("always");
    expect(data.events).toHaveLength(1);
    expect(data.events[0].name).toBe("DR-001");
    expect(data.events[0].dutyCyclePercentage).toBe(50);
  });

  it("should report no DR events", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          settings: { drAccept: "askMe" },
          events: [{ type: "hold", name: "h1" }],
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetDemandResponse(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_demand_response"].handler(
      { thermostatId: "123" },
      signal,
    );

    const text = result.content[0].text;
    expect(text).toContain("No demand response events");
    expect(text).toContain("askMe");
  });

  it("should handle no thermostat found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetDemandResponse(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_demand_response"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No thermostat found");
  });
});
