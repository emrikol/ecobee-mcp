import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerSetHold } from "../../src/tools/set-hold.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("set_hold tool", () => {
  it("should hold by climate ref", async () => {
    const { server, cache } = createServer();
    const setHold = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHold,
    } as unknown as EcobeeApiClient;

    registerSetHold(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_hold"].handler(
      {
        thermostatId: "123",
        climateRef: "away",
        holdType: "indefinite",
      },
      signal,
    );

    expect(setHold).toHaveBeenCalledTimes(1);
    const params = setHold.mock.calls[0][1];
    expect(params.holdClimateRef).toBe("away");
    expect(params.holdType).toBe("indefinite");
    expect(
      (result.structuredContent as { requestedChange: { climateRef: string } })
        .requestedChange.climateRef,
    ).toBe("away");
  });

  it("should hold by custom temps", async () => {
    const { server, cache } = createServer();
    const setHold = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHold,
    } as unknown as EcobeeApiClient;

    registerSetHold(server, api, cache);
    const tools = getTools(server);
    await tools["set_hold"].handler(
      {
        thermostatId: "123",
        heatTemp: 68,
        coolTemp: 74,
        holdType: "nextTransition",
      },
      signal,
    );

    const params = setHold.mock.calls[0][1];
    expect(params.heatHoldTemp).toBe(680);
    expect(params.coolHoldTemp).toBe(740);
  });

  it("should error without climateRef or temps", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerSetHold(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_hold"].handler(
      { thermostatId: "123", holdType: "nextTransition" },
      signal,
    );

    expect(result.isError).toBe(true);
  });
});
