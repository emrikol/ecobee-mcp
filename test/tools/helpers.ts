import { vi } from "vitest";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { EcobeeCache } from "../../src/ecobee/cache.js";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export type ToolRegistry = Record<
  string,
  { handler: (...args: unknown[]) => Promise<TestToolResult> }
>;

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

export const signal = {
  mcpReq: { signal: new AbortController().signal },
} as unknown as ServerContext;

export function parseResult(result: { structuredContent?: unknown }): unknown {
  if (result.structuredContent === undefined) {
    throw new Error("Expected a structured tool result");
  }
  const structured = result.structuredContent;
  if (
    typeof structured === "object" &&
    structured !== null &&
    !Array.isArray(structured)
  ) {
    const values = Object.values(structured);
    if (values.length === 1) return values[0];
  }
  return structured;
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
