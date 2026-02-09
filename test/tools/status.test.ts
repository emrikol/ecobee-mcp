import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetThermostatStatus } from "../../src/tools/status.js";
import type { Thermostat } from "../../src/ecobee/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistry = Record<string, { handler: (...args: any[]) => Promise<any> }>;

function getTools(server: McpServer): ToolRegistry {
  return (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
}

function mockApi(thermostats: Thermostat[]): EcobeeApiClient {
  return {
    getThermostats: vi.fn().mockResolvedValue(thermostats),
  } as unknown as EcobeeApiClient;
}

function makeThermostat(overrides?: Partial<Thermostat>): Thermostat {
  return {
    identifier: "123456",
    name: "Main Floor",
    thermostatRev: "rev1",
    isRegistered: true,
    modelNumber: "athenaSmart",
    brand: "ecobee",
    features: "",
    lastModified: "2024-01-01",
    thermostatTime: "2024-06-15 14:30:00",
    utcTime: "2024-06-15 18:30:00",
    runtime: {
      runtimeRev: "rev1",
      connected: true,
      firstConnected: "",
      connectDateTime: "",
      disconnectDateTime: "",
      lastModified: "",
      lastStatusModified: "",
      runtimeDate: "",
      runtimeInterval: 0,
      actualTemperature: 720,
      actualHumidity: 45,
      rawTemperature: 720,
      showIconMode: 0,
      desiredHeat: 680,
      desiredCool: 760,
      desiredHumidity: 36,
      desiredDehumidity: 60,
      desiredFanMode: "auto",
      desiredHeatRange: [],
      desiredCoolRange: [],
    },
    settings: {
      hvacMode: "auto",
    } as Thermostat["settings"],
    events: [],
    equipmentStatus: "fan",
    ...overrides,
  };
}

describe("get_thermostat_status tool", () => {
  let server: McpServer;
  let cache: EcobeeCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    cache = new EcobeeCache();
  });

  it("should return thermostat status with temps in F", async () => {
    const api = mockApi([makeThermostat()]);
    registerGetThermostatStatus(server, api, cache);

    const tools = getTools(server);
    const statusTool = tools["get_thermostat_status"];
    expect(statusTool).toBeDefined();

    const result = await statusTool.handler(
      { thermostatId: undefined },
      { signal: new AbortController().signal } as never,
    );
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(data.temperature).toBe(72);
    expect(data.humidity).toBe(45);
    expect(data.hvacMode).toBe("auto");
    expect(data.desiredHeat).toBe(68);
    expect(data.desiredCool).toBe(76);
  });

  it("should show active hold info", async () => {
    const thermostat = makeThermostat({
      events: [
        {
          type: "hold",
          name: "hold",
          running: true,
          startDate: "2024-06-15",
          startTime: "14:00:00",
          endDate: "2024-06-15",
          endTime: "18:00:00",
          heatHoldTemp: 700,
          coolHoldTemp: 740,
          holdClimateRef: "away",
          isOccupied: false,
          isCoolOff: false,
          isHeatOff: false,
          fan: "auto",
          vent: "",
          ventilatorMinOnTime: 0,
          isOptional: true,
          isTemperatureRelative: false,
          isTemperatureAbsolute: false,
          dutyCyclePercentage: 0,
          fanMinOnTime: 0,
          occupiedSensorActive: false,
          unoccupiedSensorActive: false,
          drRampUpTemp: 0,
          drRampUpTime: 0,
          linkRef: "",
        },
      ],
    });

    const api = mockApi([thermostat]);
    registerGetThermostatStatus(server, api, cache);

    const tools = getTools(server);
    const result = await tools["get_thermostat_status"].handler(
      { thermostatId: undefined },
      { signal: new AbortController().signal } as never,
    );
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(data.activeHold).toBeTruthy();
    expect(data.activeHold.type).toBe("away");
    expect(data.activeHold.heatTemp).toBe(70);
  });

  it("should handle no thermostats found", async () => {
    const api = mockApi([]);
    registerGetThermostatStatus(server, api, cache);

    const tools = getTools(server);
    const result = await tools["get_thermostat_status"].handler(
      { thermostatId: "999" },
      { signal: new AbortController().signal } as never,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("should handle missing runtime gracefully", async () => {
    const thermostat = makeThermostat({
      runtime: undefined,
      settings: undefined,
      events: [],
      equipmentStatus: undefined,
    });

    const api = mockApi([thermostat]);
    registerGetThermostatStatus(server, api, cache);

    const tools = getTools(server);
    const result = await tools["get_thermostat_status"].handler(
      { thermostatId: "123456" },
      { signal: new AbortController().signal } as never,
    );
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(data.connected).toBe(false);
    expect(data.temperature).toBeNull();
    expect(data.humidity).toBeNull();
    expect(data.hvacMode).toBe("unknown");
    expect(data.desiredHeat).toBeNull();
    expect(data.desiredCool).toBeNull();
    expect(data.equipmentStatus).toBe("");
    expect(data.activeHold).toBeNull();
    expect(data.activeVacation).toBeNull();
  });

  it("should show active vacation info", async () => {
    const thermostat = makeThermostat({
      events: [
        {
          type: "vacation",
          name: "Feb07-Feb09",
          running: true,
          startDate: "2026-02-07",
          startTime: "00:00:00",
          endDate: "2026-02-09",
          endTime: "00:00:00",
          heatHoldTemp: 650,
          coolHoldTemp: 780,
          holdClimateRef: "",
          isOccupied: false,
          isCoolOff: false,
          isHeatOff: false,
          fan: "auto",
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
        },
      ],
    });

    const api = mockApi([thermostat]);
    registerGetThermostatStatus(server, api, cache);

    const tools = getTools(server);
    const result = await tools["get_thermostat_status"].handler(
      { thermostatId: undefined },
      { signal: new AbortController().signal } as never,
    );
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(data.activeVacation).toBeTruthy();
    expect(data.activeVacation.name).toBe("Feb07-Feb09");
    expect(data.activeVacation.heatTemp).toBe(65);
    expect(data.activeVacation.coolTemp).toBe(78);
    expect(data.activeHold).toBeNull();
  });
});
