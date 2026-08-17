import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetSensors } from "../../src/tools/sensors.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_sensors tool", () => {
  it("should return sensor data with converted temps", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          remoteSensors: [
            {
              id: "rs:100",
              name: "Living Room",
              type: "ecobee3_remote_sensor",
              code: "ABCD",
              inUse: true,
              capability: [
                { id: "1", type: "temperature", value: "715" },
                { id: "2", type: "occupancy", value: "true" },
              ],
            },
          ],
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetSensors(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_sensors"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = (
      parseResult(result) as {
        sensors: Array<{
          name: string;
          temperature: number;
          occupancy: string;
        }>;
      }
    ).sensors;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Living Room");
    expect(data[0].temperature).toBe(71.5);
  });

  it("should handle no thermostats found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetSensors(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_sensors"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("should parse humidity capability", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          remoteSensors: [
            {
              id: "rs:200",
              name: "Bedroom",
              type: "ecobee3_remote_sensor",
              code: "EFGH",
              inUse: true,
              capability: [
                { id: "1", type: "temperature", value: "680" },
                { id: "2", type: "humidity", value: "55" },
                { id: "3", type: "occupancy", value: "false" },
              ],
            },
          ],
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetSensors(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_sensors"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = (
      parseResult(result) as {
        sensors: Array<{
          name: string;
          temperature: number;
          humidity: number;
          occupancy: boolean;
        }>;
      }
    ).sensors;
    expect(data[0].humidity).toBe(55);
    expect(data[0].occupancy).toBe(false);
    expect(data[0].temperature).toBe(68);
  });
});
