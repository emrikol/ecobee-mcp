import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerListThermostats } from "../../src/tools/list-thermostats.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("list_thermostats tool", () => {
  it("should list thermostats with status", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main Floor",
          modelNumber: "athenaSmart",
          runtime: { connected: true },
        },
        {
          identifier: "456",
          name: "Upstairs",
          modelNumber: "nikeSmart",
          runtime: { connected: false },
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerListThermostats(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_thermostats"].handler({}, signal);

    const data = parseResult(result) as Array<{
      id: string;
      name: string;
      connected: boolean;
      model: string;
    }>;
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe("123");
    expect(data[0].name).toBe("Main Floor");
    expect(data[0].connected).toBe(true);
    expect(data[1].connected).toBe(false);
  });

  it("should handle missing runtime", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "789",
          name: "Garage",
          modelNumber: "corSmart",
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerListThermostats(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_thermostats"].handler({}, signal);

    const data = parseResult(result) as Array<{
      id: string;
      connected: boolean;
    }>;
    expect(data[0].connected).toBe(false);
  });
});
