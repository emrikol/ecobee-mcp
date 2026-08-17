import { describe, it, expect } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetUtilityInfo } from "../../src/tools/utility-info.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_utility_info tool", () => {
  it("should return utility info", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          utility: {
            name: "Green Energy Co",
            phone: "555-1234",
            email: "support@green.com",
            web: "https://green.com",
          },
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetUtilityInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_utility_info"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      utility: { name: string; phone: string };
    };
    expect(data.utility.name).toBe("Green Energy Co");
    expect(data.utility.phone).toBe("555-1234");
  });

  it("should handle no thermostat found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetUtilityInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_utility_info"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No thermostat found");
  });

  it("should handle missing utility", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [{ identifier: "123", name: "Main" }],
    } as unknown as EcobeeApiClient;

    registerGetUtilityInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_utility_info"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No utility information");
  });
});
