import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerSetMode } from "../../src/tools/set-mode.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("set_hvac_mode tool", () => {
  it("should set HVAC mode", async () => {
    const { server, cache } = createServer();
    const setHvacMode = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      setHvacMode,
    } as unknown as EcobeeApiClient;

    registerSetMode(server, api, cache);
    const tools = getTools(server);
    const result = await tools["set_hvac_mode"].handler(
      { thermostatId: "123", mode: "heat" },
      signal,
    );

    expect(setHvacMode).toHaveBeenCalledWith("123", "heat");
    expect(result.content[0].text).toContain("heat");
  });
});
