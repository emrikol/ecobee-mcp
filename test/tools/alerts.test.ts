import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import {
  registerGetAlerts,
  registerAcknowledgeAlert,
} from "../../src/tools/alerts.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("alert tools", () => {
  it("get_alerts should return alerts", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi.fn().mockResolvedValue([
        {
          identifier: "123",
          name: "Main",
          alerts: [
            {
              acknowledgeRef: "ref1",
              date: "2026-02-07",
              time: "10:00:00",
              severity: "high",
              text: "Filter needs replacement",
              alertNumber: 1,
              alertType: "alert",
              isOperatorAlert: false,
              reminder: "",
              showIdt: true,
              showWeb: true,
              sendEmail: false,
              acknowledgement: "unacknowledged",
              remindMeLater: false,
              thermostatIdentifier: "123",
              notificationType: "furnaceFilter",
            },
          ],
        },
      ]),
    } as unknown as EcobeeApiClient;

    registerGetAlerts(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_alerts"].handler(
      { thermostatId: "123" },
      signal,
    );

    const data = (
      result.structuredContent as {
        alerts: Array<{ text: string; severity: string }>;
      }
    ).alerts;
    expect(data).toHaveLength(1);
    expect(data[0].text).toContain("Filter");
    expect(data[0].severity).toBe("high");
  });

  it("get_alerts should show no alerts message", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getThermostats: vi
        .fn()
        .mockResolvedValue([{ identifier: "123", name: "Main", alerts: [] }]),
    } as unknown as EcobeeApiClient;

    registerGetAlerts(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_alerts"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No active alerts");
  });

  it("get_alerts should handle no thermostats", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerGetAlerts(server, api, cache);
    const tools = getTools(server);
    const result = await tools["get_alerts"].handler(
      { thermostatId: "123" },
      signal,
    );

    expect(result.content[0].text).toContain("No thermostats found");
  });

  it("acknowledge_alert should call api", async () => {
    const { server, cache } = createServer();
    const acknowledgeAlert = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      acknowledgeAlert,
    } as unknown as EcobeeApiClient;

    registerAcknowledgeAlert(server, api, cache);
    const tools = getTools(server);
    const result = await tools["acknowledge_alert"].handler(
      { thermostatId: "123", acknowledgeRef: "ref1", ackType: "accept" },
      signal,
    );

    expect(acknowledgeAlert).toHaveBeenCalledWith("123", "ref1", "accept");
    expect(result.content[0].text).toContain("acknowledged");
  });
});
