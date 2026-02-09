import { describe, it, expect, vi } from "vitest";
import type { EcobeeApiClient } from "../../src/ecobee/api.js";
import { registerSendMessage } from "../../src/tools/send-message.js";
import { createServer, getTools, mockApiBase, signal } from "./helpers.js";

describe("send_message tool", () => {
  it("should send message to thermostat", async () => {
    const { server, cache } = createServer();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...mockApiBase(),
      sendMessage,
    } as unknown as EcobeeApiClient;

    registerSendMessage(server, api, cache);
    const tools = getTools(server);
    const result = await tools["send_message"].handler(
      { thermostatId: "123", text: "Hello from Claude!" },
      signal,
    );

    expect(sendMessage).toHaveBeenCalledWith("123", "Hello from Claude!");
    expect(result.content[0].text).toContain("sent");
  });
});
