import { McpServer } from "@modelcontextprotocol/server/runtime";
import {
  MCP_PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./constants.js";

/* v8 ignore start -- Integration test: MCP server factory wiring.
   Test that createMcpServer registers one captured tool-catalog snapshot plus
   startup-static resources. Verify with an official client session. */
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
import { registerCatalogTools, type ToolCatalogSnapshot } from "./catalog.js";
import { registerAllResources } from "./resources/index.js";

/**
 * Create a configured MCP server instance.
 * Each modern HTTP request gets its own McpServer, sharing the API client and cache.
 */
export function createMcpServer(
  api: EcobeeApiClient,
  cache: EcobeeCache,
  catalog: ToolCatalogSnapshot,
  resourcePlugins: readonly EcobeePlugin[] = [],
  performanceCaches = true,
  toolsListChanged = false,
): McpServer {
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
    },
    {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      performanceCaches,
      capabilities: {
        tools: { listChanged: toolsListChanged },
        resources: { listChanged: false },
      },
    },
  );

  // The request retains this exact catalog snapshot for its full lifetime.
  registerCatalogTools(server, catalog);
  registerAllResources(server, api, cache);

  // Resource plugins remain startup-static. Only the tool catalog has an
  // explicit runtime reload boundary and matching list-changed capability.
  for (const plugin of resourcePlugins) {
    if (plugin.registerResources) {
      plugin.registerResources(server, cache);
    }
  }

  return server;
}
