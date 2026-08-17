import { McpServer } from "@modelcontextprotocol/server";
import {
  MCP_PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./constants.js";

/* v8 ignore start -- Integration test: MCP server factory wiring.
   Test that createMcpServer correctly registers all built-in tools/resources
   and applies plugin tools/resources. Verify with MCP Inspector or real
   MCP client session that all 24 tools and 3 resources are discoverable. */
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { traceSync } from "./observability.js";

/**
 * Create a configured MCP server instance.
 * Each modern HTTP request gets its own McpServer, sharing the API client and cache.
 */
export function createMcpServer(
  api: EcobeeApiClient,
  cache: EcobeeCache,
  plugins: EcobeePlugin[] = [],
): McpServer {
  return traceSync(
    "mcp.server.create",
    {
      "mcp.protocol.version": MCP_PROTOCOL_VERSION,
      "mcp.tools.count": 24,
      "mcp.resources.count": 3,
    },
    () => {
      const server = new McpServer(
        {
          name: SERVICE_NAME,
          version: SERVICE_VERSION,
        },
        {
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
        },
      );

      // Register built-in tools and resources
      registerAllTools(server, api, cache);
      registerAllResources(server, api, cache);

      // Register plugin tools and resources
      for (const plugin of plugins) {
        if (plugin.registerTools) {
          plugin.registerTools(server, api, cache);
          console.log("[server] Registered plugin tools");
        }
        if (plugin.registerResources) {
          plugin.registerResources(server, cache);
          console.log("[server] Registered plugin resources");
        }
      }

      return server;
    },
  );
}
