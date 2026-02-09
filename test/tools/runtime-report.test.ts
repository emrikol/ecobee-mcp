import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerGetRuntimeReport } from "../../src/tools/runtime-report.js";
import { createServer, getTools, mockApiBase, parseResult, signal } from "./helpers.js";

describe("get_runtime_report tool", () => {
  it("should return summarized report", async () => {
    const { server, cache } = createServer();
    const getRuntimeReport = vi.fn().mockResolvedValue({
      startDate: "2026-02-01",
      startInterval: 0,
      endDate: "2026-02-02",
      endInterval: 0,
      columns: "auxHeat1,cool1,fan,zoneAveTemp",
      reportList: [
        {
          thermostatIdentifier: "123",
          rowCount: 4,
          rowList: [
            "2026-02-01,00:00:00,120,0,300,710",
            "2026-02-01,00:05:00,0,0,0,715",
            "2026-02-02,00:00:00,60,0,180,720",
            "2026-02-02,00:05:00,0,0,0,725",
          ],
        },
      ],
      sensorList: [],
      status: { code: 0, message: "" },
    });
    const api = {
      ...mockApiBase(),
      getRuntimeReport,
    } as unknown as EcobeeApiClient;

    registerGetRuntimeReport(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_runtime_report"].handler(
      {
        thermostatId: "123",
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        preset: "all",
        summarize: true,
      },
      signal,
    );

    expect(getRuntimeReport).toHaveBeenCalledTimes(1);
    const data = parseResult(result) as {
      dailySummaries: Record<string, Record<string, number>>;
    };
    expect(data.dailySummaries).toBeDefined();
    expect(data.dailySummaries["2026-02-01"]).toBeDefined();
  });

  it("should return raw intervals when summarize=false", async () => {
    const { server, cache } = createServer();
    const getRuntimeReport = vi.fn().mockResolvedValue({
      startDate: "2026-02-01",
      startInterval: 0,
      endDate: "2026-02-01",
      endInterval: 287,
      columns: "auxHeat1,fan",
      reportList: [
        {
          thermostatIdentifier: "123",
          rowCount: 2,
          rowList: [
            "2026-02-01,00:00:00,120,300",
            "2026-02-01,00:05:00,0,0",
          ],
        },
      ],
      sensorList: [],
      status: { code: 0, message: "" },
    });
    const api = {
      ...mockApiBase(),
      getRuntimeReport,
    } as unknown as EcobeeApiClient;

    registerGetRuntimeReport(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_runtime_report"].handler(
      {
        thermostatId: "123",
        startDate: "2026-02-01",
        endDate: "2026-02-01",
        summarize: false,
      },
      signal,
    );

    const data = parseResult(result) as {
      intervals: number;
      data: Array<Record<string, string>>;
    };
    expect(data.intervals).toBe(2);
    expect(data.data).toHaveLength(2);
  });

  it("should handle empty report list", async () => {
    const { server, cache } = createServer();
    const getRuntimeReport = vi.fn().mockResolvedValue({
      reportList: [],
      sensorList: [],
      status: { code: 0, message: "" },
    });
    const api = {
      ...mockApiBase(),
      getRuntimeReport,
    } as unknown as EcobeeApiClient;

    registerGetRuntimeReport(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_runtime_report"].handler(
      {
        thermostatId: "123",
        startDate: "2026-02-01",
        endDate: "2026-02-01",
        summarize: true,
      },
      signal,
    );

    expect(result.content[0].text).toContain("No runtime data");
  });
});
