import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolRegistry = Record<string, { handler: (...args: any[]) => Promise<any> }>;

export function getTools(server: McpServer): ToolRegistry {
  return (server as unknown as { _registeredTools: ToolRegistry })
    ._registeredTools;
}

export function createServer(): { server: McpServer; cache: EcobeeCache } {
  return {
    server: new McpServer({ name: "test", version: "0.0.1" }),
    cache: new EcobeeCache(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const signal = { signal: new AbortController().signal } as any;

export function parseResult(result: {
  content: Array<{ type: string; text: string }>;
}): unknown {
  return JSON.parse(result.content[0].text);
}

export function mockApiBase(): Partial<EcobeeApiClient> {
  return {
    getThermostats: vi.fn().mockResolvedValue([]),
    getThermostatSummary: vi.fn().mockResolvedValue({
      revisionList: [],
      thermostatCount: 0,
      statusList: [],
    }),
    updateThermostat: vi.fn().mockResolvedValue(undefined),
    createVacation: vi.fn().mockResolvedValue(undefined),
    deleteVacation: vi.fn().mockResolvedValue(undefined),
    setHold: vi.fn().mockResolvedValue(undefined),
    resumeProgram: vi.fn().mockResolvedValue(undefined),
    setHvacMode: vi.fn().mockResolvedValue(undefined),
    acknowledgeAlert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    updateComfortProfile: vi.fn().mockResolvedValue(undefined),
    getRuntimeReport: vi.fn().mockResolvedValue({}),
    getGroups: vi.fn().mockResolvedValue([]),
    updateGroups: vi.fn().mockResolvedValue([]),
  };
}
