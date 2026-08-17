import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import {
  registerListGroups,
  registerManageGroup,
} from "../../src/tools/groups.js";
import {
  createServer,
  getTools,
  mockApiBase,
  parseResult,
  signal,
} from "./helpers.js";

describe("group tools", () => {
  it("list_groups should show groups with sync flags", async () => {
    const { server, cache } = createServer();
    const api = {
      ...mockApiBase(),
      getGroups: async () => [
        {
          groupRef: "abc123",
          groupName: "ground_floor",
          synchronizeAlerts: false,
          synchronizeSystemMode: true,
          synchronizeSchedule: true,
          synchronizeQuickSave: false,
          synchronizeReminders: false,
          synchronizeContractorInfo: false,
          synchronizeUserPreferences: false,
          synchronizeUtilityInfo: false,
          synchronizeLocation: false,
          synchronizeReset: false,
          synchronizeVacation: true,
          thermostats: ["111", "222"],
        },
      ],
    } as unknown as EcobeeApiClient;

    registerListGroups(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_groups"].handler({}, signal);

    const data = parseResult(result) as Array<{
      groupName: string;
      synchronizing: string[];
      thermostats: string[];
    }>;
    expect(data).toHaveLength(1);
    expect(data[0].groupName).toBe("ground_floor");
    expect(data[0].thermostats).toEqual(["111", "222"]);
    expect(data[0].synchronizing).toContain("SystemMode");
    expect(data[0].synchronizing).toContain("Schedule");
    expect(data[0].synchronizing).toContain("Vacation");
    expect(data[0].synchronizing).not.toContain("Alerts");
  });

  it("list_groups should handle empty", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerListGroups(server, api, cache);
    const tools = getTools(server);
    const result = await tools["list_groups"].handler({}, signal);

    expect(result.content[0].text).toContain("No thermostat groups");
  });

  it("manage_group should create a group", async () => {
    const { server, cache } = createServer();
    const updateGroups = vi
      .fn()
      .mockResolvedValue([
        { groupRef: "new123", groupName: "upstairs", thermostats: ["111"] },
      ]);
    const api = {
      ...mockApiBase(),
      updateGroups,
    } as unknown as EcobeeApiClient;

    registerManageGroup(server, api, cache);
    const tools = getTools(server);
    const result = await tools["manage_group"].handler(
      {
        groupName: "upstairs",
        thermostats: ["111"],
        synchronizeSystemMode: true,
      },
      signal,
    );

    expect(updateGroups).toHaveBeenCalledTimes(1);
    const sent = updateGroups.mock.calls[0][0][0];
    expect(sent.groupName).toBe("upstairs");
    expect(sent.synchronizeSystemMode).toBe(true);
    expect(result.content[0].text).toContain("Created");
  });

  it("manage_group should delete with empty thermostats", async () => {
    const { server, cache } = createServer();
    const updateGroups = vi.fn().mockResolvedValue([]);
    const api = {
      ...mockApiBase(),
      updateGroups,
    } as unknown as EcobeeApiClient;

    registerManageGroup(server, api, cache);
    const tools = getTools(server);
    const result = await tools["manage_group"].handler(
      { groupRef: "abc123", groupName: "old", thermostats: [] },
      signal,
    );

    expect(result.content[0].text).toContain("deleted");
  });

  it("manage_group should update existing group", async () => {
    const { server, cache } = createServer();
    const updateGroups = vi.fn().mockResolvedValue([
      {
        groupRef: "abc123",
        groupName: "ground_floor",
        thermostats: ["111", "222", "333"],
      },
    ]);
    const api = {
      ...mockApiBase(),
      updateGroups,
    } as unknown as EcobeeApiClient;

    registerManageGroup(server, api, cache);
    const tools = getTools(server);
    const result = await tools["manage_group"].handler(
      {
        groupRef: "abc123",
        groupName: "ground_floor",
        thermostats: ["111", "222", "333"],
        synchronizeVacation: true,
      },
      signal,
    );

    expect(result.content[0].text).toContain("Updated");
    expect(updateGroups).toHaveBeenCalledTimes(1);
    const sent = updateGroups.mock.calls[0][0][0];
    expect(sent.groupRef).toBe("abc123");
    expect(sent.synchronizeVacation).toBe(true);
  });

  it("manage_group should error without name or ref", async () => {
    const { server, cache } = createServer();
    const api = mockApiBase() as unknown as EcobeeApiClient;

    registerManageGroup(server, api, cache);
    const tools = getTools(server);
    const result = await tools["manage_group"].handler(
      { thermostats: ["111"] },
      signal,
    );

    expect(result.isError).toBe(true);
  });
});
