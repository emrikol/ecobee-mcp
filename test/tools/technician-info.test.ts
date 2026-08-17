import { describe, it, expect } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetTechnicianInfo } from "../../src/tools/technician-info.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("get_technician_info tool", () => {
  it("should return technician info", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [
        {
          identifier: "123",
          name: "Main",
          technician: {
            contractorRef: "abc123",
            name: "HVAC Pros",
            phone: "555-9876",
            streetAddress: "123 Main St",
            city: "Springfield",
            provinceState: "IL",
            country: "US",
            postalCode: "62701",
            email: "service@hvacpros.com",
            web: "https://hvacpros.com",
          },
        },
      ],
    } as unknown as EcobeeApiClient;

    registerGetTechnicianInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_technician_info"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = parseResult(result) as {
      technician: { name: string; city: string };
    };
    expect(data.technician.name).toBe("HVAC Pros");
    expect(data.technician.city).toBe("Springfield");
  });

  it("should handle no thermostat found", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetTechnicianInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_technician_info"].handler(
      { thermostatId: "999" },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No thermostat found");
  });

  it("should handle no technician", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: async () => [{ identifier: "123", name: "Main" }],
    } as unknown as EcobeeApiClient;

    registerGetTechnicianInfo(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_technician_info"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No technician");
  });
});
