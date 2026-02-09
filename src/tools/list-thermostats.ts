import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";

export function registerListThermostats(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "list_thermostats",
    {
      description:
        "List all registered Ecobee thermostats with their ID, name, and connection status.",
      inputSchema: {
        random_string: z
          .string()
          .optional()
          .describe("Unused parameter, pass any value"),
      },
    },
    async () => {
      const thermostats = await cache.getOrFetch(
        "all:list",
        async () => {
          return api.getThermostats({
            selectionType: "registered",
            selectionMatch: "",
            includeRuntime: true,
          });
        },
      );

      const result = thermostats.map((t) => ({
        id: t.identifier,
        name: t.name,
        connected: t.runtime?.connected ?? false,
        model: t.modelNumber,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
