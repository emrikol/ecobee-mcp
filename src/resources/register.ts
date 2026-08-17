import type {
  McpServer,
  ReadResourceResult,
} from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import { MAX_TOOL_RESULT_BYTES } from "../tools/contracts.js";

export function registerEcobeeResource(
  server: McpServer,
  api: EcobeeApiClient,
  name: string,
  uri: string,
  config: { description: string; mimeType?: string },
  handler: () => Promise<ReadResourceResult>,
): void {
  server.registerResource(name, uri, config, async (_uri, ctx) => {
    try {
      const result = await api.withRequestSignal(ctx.mcpReq.signal, handler);
      const bytes = result.contents.reduce((total, content) => {
        if ("text" in content)
          return total + Buffer.byteLength(content.text, "utf8");
        return total + Buffer.byteLength(content.blob, "base64");
      }, 0);
      if (bytes > MAX_TOOL_RESULT_BYTES) {
        throw new Error("Resource response is too large.");
      }
      return result;
    } catch {
      throw new Error("Ecobee resource read failed.");
    }
  });
}
