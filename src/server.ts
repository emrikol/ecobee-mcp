/* v8 ignore start -- Integration test: MCP server factory wiring.
   Test that createMcpServer correctly registers all built-in tools/resources
   and applies plugin tools/resources. Verify with MCP Inspector or real
   MCP client session that all 24 tools and 3 resources are discoverable. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";

/**
 * Create a configured MCP server instance.
 * Each HTTP session gets its own McpServer, sharing the API client and cache.
 */
export function createMcpServer(
  api: EcobeeApiClient,
  cache: EcobeeCache,
  plugins: EcobeePlugin[] = [],
): McpServer {
  const server = new McpServer({
    name: "ecobee-mcp",
    version: "1.0.0",
  });

  // Register built-in tools and resources
  registerAllTools(server, api, cache);
  registerAllResources(server, api, cache);

  // Register plugin tools and resources
  for (const plugin of plugins) {
    if (plugin.registerTools) {
      plugin.registerTools(server, api, cache);
      console.log(`[server] Plugin "${plugin.name}" registered tools`);
    }
    if (plugin.registerResources) {
      plugin.registerResources(server, cache);
      console.log(`[server] Plugin "${plugin.name}" registered resources`);
    }
  }

  return server;
}
