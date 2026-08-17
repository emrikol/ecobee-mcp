import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import {
  AmbiguousMutationDeliveryError,
  type EcobeeApiClient,
} from "../../src/ecobee/api.js";
import { registerSetVacation } from "../../src/tools/set-vacation.js";

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface StructuredVacationResult {
  requestedChange: {
    dryRun: boolean;
    vacations: Array<{
      name: string;
      heatTemp: number;
      coolTemp: number;
      startTime: string;
      endTime: string;
    }>;
  };
}

function vacationChange(result: TestToolResult) {
  return (result.structuredContent as unknown as StructuredVacationResult)
    .requestedChange;
}

type ToolRegistry = Record<
  string,
  { handler: (...args: unknown[]) => Promise<TestToolResult> }
>;

function getTools(server: McpServer): ToolRegistry {
  return (server as unknown as { _registeredTools: ToolRegistry })
    ._registeredTools;
}

interface MockVacation {
  name: string;
  heatHoldTemp?: number;
  coolHoldTemp?: number;
}

function mockApi(
  existingVacations: (string | MockVacation)[] = [],
): EcobeeApiClient {
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
            startDate: "2026-03-01",
            startTime: "00:00:00",
            endDate: "2026-03-08",
            endTime: "00:00:00",
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(api.createVacationsBulk).toHaveBeenCalledTimes(1);
  });

  it("should not retry individually when bulk delivery fails", async () => {
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(api.createVacationsBulk).toHaveBeenCalledTimes(1);
    expect(api.createVacation).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("Ecobee operation failed.");
  });

  it("should delete vacation by name", async () => {
    const api = mockApi(["My Vacation"]);
    (api.getThermostats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { identifier: "123", name: "Main", events: [] },
    ]);
    registerSetVacation(server, api, cache);

    const tools = getTools(server);
    const result = await tools["set_vacation"].handler(
      {
        action: "delete",
        thermostatId: "123",
        vacationName: "My Vacation",
        dryRun: false,
      },
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(api.deleteVacation).toHaveBeenCalledWith("123", "My Vacation");
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("deleted");
  });

  it("should default temps from existing vacations when omitted", async () => {
    const api = mockApi([
      { name: "Old", heatHoldTemp: 620, coolHoldTemp: 760 },
    ]);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Ecobee operation failed.");
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Ecobee operation failed.");
  });

  it("should surface ambiguous bulk delivery without retrying", async () => {
    const api = mockApi();
    (api.createVacationsBulk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AmbiguousMutationDeliveryError(),
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    expect(result.isError).toBe(true);
    expect(api.createVacationsBulk).toHaveBeenCalledTimes(1);
    expect(api.createVacation).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain("ambiguous");
    expect(text).toContain("not retried");
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
      { mcpReq: { signal: new AbortController().signal } } as never,
    );

    const data = vacationChange(result);
    expect(data.vacations[0].name).toBe("Mar01-Mar083");
  });
});
