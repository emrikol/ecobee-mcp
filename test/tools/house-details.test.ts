import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import {
  registerGetHouseDetails,
  registerUpdateHouseDetails,
} from "../../src/tools/house-details.js";
import { createServer, getTools, mockApiBase, parseResult, signal } from "./helpers.js";

describe("house details tools", () => {
  it("get_house_details should return house info", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          houseDetails: {
            style: "detached",
            size: 2400,
            numberOfFloors: 2,
            numberOfRooms: 8,
            numberOfOccupants: 4,
            age: 15,
            windowEfficiency: 5,
          },
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetHouseDetails(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_house_details"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      houseDetails: { style: string; size: number };
    };
    expect(data.houseDetails.style).toBe("detached");
    expect(data.houseDetails.size).toBe(2400);
  });

  it("get_house_details should handle missing data", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        { identifier: "123", name: "Main" },
      ],
    } as unknown as EcobeeApiClient;

    registerGetHouseDetails(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_house_details"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No house details");
  });

  it("get_house_details should handle no thermostat found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetHouseDetails(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_house_details"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No thermostat found");
  });

  it("update_house_details should call updateThermostat", async () => {
    const { server, cache } = createServer();
    const updateThermostat = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      updateThermostat,
    } as unknown as EcobeeApiClient;

    registerUpdateHouseDetails(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_house_details"].handler(
      { thermostatId: "123", size: 3000, age: 20 },
      signal,
    );

    expect(updateThermostat).toHaveBeenCalledTimes(1);
    const body = updateThermostat.mock.calls[0][0];
    expect(body.thermostat.houseDetails.size).toBe(3000);
    expect(body.thermostat.houseDetails.age).toBe(20);
    expect(result.content[0].text).toContain("size");
    expect(result.content[0].text).toContain("age");
  });

  it("update_house_details should error with no fields", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerUpdateHouseDetails(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_house_details"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.isError).toBe(true);
  });
});
