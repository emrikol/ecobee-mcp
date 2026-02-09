import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerSetVacation } from "../../src/tools/set-vacation.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistry = Record<string, { handler: (...args: any[]) => Promise<any> }>;

function getTools(server: McpServer): ToolRegistry {
  return (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
}

interface MockVacation {
  name: string;
  heatHoldTemp?: number;
  coolHoldTemp?: number;
}

function mockApi(existingVacations: (string | MockVacation)[] = []): EcobeeApiClient {
  return {
    getThermostats: vi.fn().mockResolvedValue([
      {
        identifier: "123",
        name: "Main",
        events: existingVacations.map((v) => {
          const obj = typeof v === "string" ? { name: v } : v;
          return {
            type: "vacation",
            name: obj.name,
            heatHoldTemp: obj.heatHoldTemp ?? 650,
            coolHoldTemp: obj.coolHoldTemp ?? 780,
            running: false,
          };
        }),
        runtime: { connected: true },
      },
    ]),
    createVacation: vi.fn().mockResolvedValue(undefined),
    createVacationsBulk: vi.fn().mockResolvedValue(undefined),
    deleteVacation: vi.fn().mockResolvedValue(undefined),
  } as unknown as EcobeeApiClient;
}

describe("set_vacation tool", () => {
  let server: McpServer;
  let cache: EcobeeCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    cache = new EcobeeCache();
  });

  it("should auto-generate vacation name from dates", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        coolTemp: 78,
        heatTemp: 62,
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-08",
        endTime: "00:00:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(data.dryRun).toBe(true);
    expect(data.vacations[0].name).toBe("Mar01-Mar08");
  });

  it("should make unique names when conflicts exist", async () => {
    const api = mockApi(["Mar01-Mar08"]);
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        coolTemp: 78,
        heatTemp: 62,
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-08",
        endTime: "00:00:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(data.vacations[0].name).toBe("Mar01-Mar082");
  });

  it("should use bulk create for multiple vacations", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        vacations: [
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-03-01",
            startTime: "00:00:00",
            endDate: "2026-03-08",
            endTime: "00:00:00",
          },
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-04-01",
            startTime: "00:00:00",
            endDate: "2026-04-08",
            endTime: "00:00:00",
          },
        ],
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(api.createVacationsBulk).toHaveBeenCalledTimes(1);
  });

  it("should fall back to individual creates when bulk fails", async () => {
    const api = mockApi();
    (api.createVacationsBulk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("bulk failed"),
    );
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        vacations: [
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-03-01",
            startTime: "00:00:00",
            endDate: "2026-03-08",
            endTime: "00:00:00",
          },
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-04-01",
            startTime: "00:00:00",
            endDate: "2026-04-08",
            endTime: "00:00:00",
          },
        ],
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(api.createVacation).toHaveBeenCalledTimes(2);
    const text = (
      result.content as Array<{ type: string; text: string }>
    )[0].text;
    expect(text).toContain("Created 2/2");
  });

  it("should delete vacation by name", async () => {
    const api = mockApi(["My Vacation"]);
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "delete",
        thermostatId: "123",
        vacationName: "My Vacation",
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(api.deleteVacation).toHaveBeenCalledWith("123", "My Vacation");
    const text = (
      result.content as Array<{ type: string; text: string }>
    )[0].text;
    expect(text).toContain("deleted");
  });

  it("should default temps from existing vacations when omitted", async () => {
    const api = mockApi([{ name: "Old", heatHoldTemp: 620, coolHoldTemp: 760 }]);
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-08",
        endTime: "00:00:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(data.defaults).toEqual({ heatTemp: 62, coolTemp: 76 });
    expect(data.vacations[0].heatTemp).toBe(62);
    expect(data.vacations[0].coolTemp).toBe(76);
  });

  it("should use 65/78 defaults when no existing vacations", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-08",
        endTime: "00:00:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(data.defaults).toEqual({ heatTemp: 65, coolTemp: 78 });
    expect(data.vacations[0].heatTemp).toBe(65);
    expect(data.vacations[0].coolTemp).toBe(78);
  });

  it("should normalize time format", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        coolTemp: 78,
        heatTemp: 62,
        startDate: "2026-03-01",
        startTime: "08:30",
        endDate: "2026-03-08",
        endTime: "17:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(data.vacations[0].startTime).toBe("08:30:00");
    expect(data.vacations[0].endTime).toBe("17:00:00");
  });

  it("should error on delete without vacationName", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "delete",
        thermostatId: "123",
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("vacationName is required");
  });

  it("should error without dates or vacations array", async () => {
    const api = mockApi();
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Provide startDate/endDate");
  });

  it("should report individual failures", async () => {
    const api = mockApi();
    (api.createVacationsBulk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("bulk failed"),
    );
    (api.createVacation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("conflict"));
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        vacations: [
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-03-01",
            startTime: "00:00:00",
            endDate: "2026-03-08",
            endTime: "00:00:00",
          },
          {
            coolTemp: 78,
            heatTemp: 62,
            startDate: "2026-04-01",
            startTime: "00:00:00",
            endDate: "2026-04-08",
            endTime: "00:00:00",
          },
        ],
        dryRun: false,
      },
      { signal: new AbortController().signal } as never,
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Created 1/2");
    expect(text).toContain("Failed");
    expect(text).toContain("conflict");
  });

  it("should handle unique name collision with counter", async () => {
    const api = mockApi(["Mar01-Mar08", "Mar01-Mar082"]);
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "create",
        thermostatId: "123",
        coolTemp: 78,
        heatTemp: 62,
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-08",
        endTime: "00:00:00",
        dryRun: true,
      },
      { signal: new AbortController().signal } as never,
    );

    const data = JSON.parse(result.content[0].text);
    expect(data.vacations[0].name).toBe("Mar01-Mar083");
  });
});
