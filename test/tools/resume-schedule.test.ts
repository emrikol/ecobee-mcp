import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerResumeSchedule } from "../../src/tools/resume-schedule.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("resume_schedule tool", () => {
  it("should resume program", async () => {
    const { server, cache } = createServer();
    const resumeProgram = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      resumeProgram,
    } as unknown as EcobeeApiClient;

    registerResumeSchedule(server, api, cache);
    const tools = getTools(server);
    const result = await tools["resume_schedule"].handler(
      { thermostatId: "123", resumeAll: false },
      signal,
    );

    expect(resumeProgram).toHaveBeenCalledWith("123", false);
    expect(result.content[0].text).toContain("resumed");
  });

  it("should resume all when requested", async () => {
    const { server, cache } = createServer();
    const resumeProgram = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      resumeProgram,
    } as unknown as EcobeeApiClient;

    registerResumeSchedule(server, api, cache);
    const tools = getTools(server);
    await tools["resume_schedule"].handler(
      { thermostatId: "123", resumeAll: true },
      signal,
    );

    expect(resumeProgram).toHaveBeenCalledWith("123", true);
  });
});
