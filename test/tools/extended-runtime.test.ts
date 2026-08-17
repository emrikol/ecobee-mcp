import { describe, it, expect } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetExtendedRuntime } from "../../src/tools/extended-runtime.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_extended_runtime tool", () => {
  it("should format 5-minute interval data", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          extendedRuntime: {
            lastReadingTimestamp: "2026-02-07 17:00:00",
            runtimeDate: "2026-02-07",
            runtimeInterval: 204, // 204*5=1020min = 17:00 UTC
            actualTemperature: [710, 715, 720],
            actualHumidity: [40, 42, 43],
            desiredHeat: [680, 680, 680],
            desiredCool: [760, 760, 760],
            desiredHumidity: [36, 36, 36],
            desiredDehumidity: [60, 60, 60],
            dmOffset: [0, 0, 0],
            hvacMode: ["auto", "auto", "auto"],
            heatPump1: [0, 0, 0],
            heatPump2: [0, 0, 0],
            auxHeat1: [120, 0, 0],
            auxHeat2: [0, 0, 0],
            auxHeat3: [0, 0, 0],
            cool1: [0, 0, 0],
            cool2: [0, 0, 0],
            fan: [120, 60, 0],
            humidifier: [0, 0, 0],
            dehumidifier: [0, 0, 0],
            economizer: [0, 0, 0],
            ventilator: [0, 0, 0],
            currentElectricityBill: 0,
            projectedElectricityBill: 0,
          },
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetExtendedRuntime(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_extended_runtime"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      readings: Array<{
        actualTemp: number;
        equipment: { auxHeat1: number; fan: number };
      }>;
    };
    expect(data.readings).toHaveLength(3);
    expect(data.readings[0].actualTemp).toBe(71);
    expect(data.readings[2].actualTemp).toBe(72);
    expect(data.readings[0].equipment.auxHeat1).toBe(120);
    expect(data.readings[0].equipment.fan).toBe(120);
  });

  it("should handle missing extended runtime", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [{ identifier: "123", name: "Main" }],
    } as unknown as EcobeeApiClient;

    registerGetExtendedRuntime(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_extended_runtime"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { readings: unknown[] }).readings,
    ).toEqual([]);
  });

  it("should handle no thermostat found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetExtendedRuntime(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_extended_runtime"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No thermostat found");
  });
});
