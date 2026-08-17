import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import {
  registerSetTemperature,
  resolveId,
} from "../../src/tools/set-temperature.js";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("set_temperature tool", () => {
  it("should set heat and cool temps", async () => {
    const { server, cache } = createServer();
    const setHold = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHold,
    } as unknown as EcobeeApiClient;

    registerSetTemperature(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_temperature"].handler(
      {
        thermostatId: "123",
        heatTemp: 70,
        coolTemp: 76,
        holdType: "nextTransition",
      },
      signal,
    );

    expect(setHold).toHaveBeenCalledTimes(1);
    const params = setHold.mock.calls[0][1];
    expect(params.heatHoldTemp).toBe(700);
    expect(params.coolHoldTemp).toBe(760);
    expect(params.holdType).toBe("nextTransition");
    expect(
      (result.structuredContent as { requestedChange: { heatTemp: number } })
        .requestedChange.heatTemp,
    ).toBe(70);
  });

  it("should set only heat temp", async () => {
    const { server, cache } = createServer();
    const setHold = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHold,
    } as unknown as EcobeeApiClient;

    registerSetTemperature(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_temperature"].handler(
      {
        thermostatId: "123",
        heatTemp: 68,
        holdType: "indefinite",
      },
      signal,
    );

    const params = setHold.mock.calls[0][1];
    expect(params.heatHoldTemp).toBe(680);
    expect(params.coolHoldTemp).toBeUndefined();
    expect(
      result.structuredContent as {
        requestedChange: { heatTemp: number; holdType: string };
      },
    ).toMatchObject({
      requestedChange: { heatTemp: 68, holdType: "indefinite" },
    });
  });

  it("should error without any temp", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerSetTemperature(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_temperature"].handler(
      { thermostatId: "123", holdType: "nextTransition" },
      signal,
    );

    expect(result.isError).toBe(true);
  });

  it("does not retry a completed mutation when reconciliation is unavailable", async () => {
    const { server, cache } = createServer();
    const setHold = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHold,
      getThermostats: vi
        .fn()
        .mockRejectedValue(new Error("readback unavailable")),
    } as unknown as EcobeeApiClient;
    registerSetTemperature(server, api, cache);

    const result = await getTools(server)["set_temperature"].handler(
      {
        thermostatId: "123",
        heatTemp: 70,
        holdType: "nextTransition",
      },
      signal,
    );

    expect(setHold).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      resultingState: { verification: string };
    };
    expect(structured.resultingState.verification).toBe("unavailable");
  });
});

describe("resolveId", () => {
  it("should return provided ID directly", async () => {
    const api = mockApiBase() as unknown as EcobeeApiClient;
    const cache = new EcobeeCache();
    const id = await resolveId("myId", api, cache);
    expect(id).toBe("myId");
  });

  it("should resolve first thermostat when no ID given", async () => {
    const api = {
      ...mockApiBase(),
      getThermostats: vi
        .fn()
        .mockResolvedValue([{ identifier: "first123", name: "Main" }]),
    } as unknown as EcobeeApiClient;
    const cache = new EcobeeCache();
    const id = await resolveId(undefined, api, cache);
    expect(id).toBe("first123");
  });

  it("should throw when no thermostats found", async () => {
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([]),
    } as unknown as EcobeeApiClient;
    const cache = new EcobeeCache();
    await expect(resolveId(undefined, api, cache)).rejects.toThrow(
      "No thermostats found",
    );
  });
});
