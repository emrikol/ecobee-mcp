import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerUpdateComfortProfile } from "../../src/tools/update-comfort-profile.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("update_comfort_profile tool", () => {
  it("should update comfort profile temps", async () => {
    const { server, cache } = createServer();
    const updateComfortProfile = vi.fn().mockResolvedValue(undefined);
    const getThermostats = vi.fn().mockResolvedValue([
      {
        identifier: "123",
        name: "Main",
        program: {
          currentClimateRef: "home",
          climates: [
            {
              name: "Home",
              climateRef: "home",
              coolTemp: 760,
              heatTemp: 700,
            },
          ],
          schedule: [],
        },
      },
    ]);
    const api = {
      ...mockApiBase(),
      getThermostats,
      updateComfortProfile,
    } as unknown as EcobeeApiClient;

    registerUpdateComfortProfile(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_comfort_profile"].handler(
      {
        thermostatId: "123",
        climateRef: "home",
        heatTemp: 72,
        coolTemp: 78,
      },
      signal,
    );

    expect(updateComfortProfile).toHaveBeenCalledWith("123", "home", {
      coolTemp: 780,
      heatTemp: 720,
    });
    expect(result.content[0].text).toContain("→");
  });

  it("should error without any temp", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerUpdateComfortProfile(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_comfort_profile"].handler(
      { thermostatId: "123", climateRef: "home" },
      signal,
    );

    expect(result.isError).toBe(true);
  });

  it("should error when climate not found", async () => {
    const { server, cache } = createServer();
    const getThermostats = vi.fn().mockResolvedValue([
      {
        identifier: "123",
        name: "Main",
        program: {
          currentClimateRef: "home",
          climates: [
            {
              name: "Home",
              climateRef: "home",
              coolTemp: 760,
              heatTemp: 700,
            },
          ],
          schedule: [],
        },
      },
    ]);
    const api = {
      ...mockApiBase(),
      getThermostats,
    } as unknown as EcobeeApiClient;

    registerUpdateComfortProfile(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_comfort_profile"].handler(
      {
        thermostatId: "123",
        climateRef: "nonexistent",
        heatTemp: 72,
      },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("home");
  });

  it("should update only cool temp", async () => {
    const { server, cache } = createServer();
    const updateComfortProfile = vi.fn().mockResolvedValue(undefined);
    const getThermostats = vi.fn().mockResolvedValue([
      {
        identifier: "123",
        name: "Main",
        program: {
          currentClimateRef: "home",
          climates: [
            {
              name: "Home",
              climateRef: "home",
              coolTemp: 760,
              heatTemp: 700,
            },
          ],
          schedule: [],
        },
      },
    ]);
    const api = {
      ...mockApiBase(),
      getThermostats,
      updateComfortProfile,
    } as unknown as EcobeeApiClient;

    registerUpdateComfortProfile(server, api, cache);
    const tools = getTools(server);
    const result = await tools["update_comfort_profile"].handler(
      {
        thermostatId: "123",
        climateRef: "home",
        coolTemp: 74,
      },
      signal,
    );

    expect(updateComfortProfile).toHaveBeenCalledWith("123", "home", {
      coolTemp: 740,
    });
    expect(result.content[0].text).toContain("cool");
    expect(result.content[0].text).not.toContain("heat");
  });
});
