import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import {
  boundedString,
  MAX_THERMOSTATS,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const outputSchema = z.object({
  thermostats: z
    .array(
      z.object({
        id: boundedString(64),
        name: boundedString(128),
        connected: z.boolean(),
        model: boundedString(128),
      }),
    )
    .max(MAX_THERMOSTATS),
});

export function registerListThermostats(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "list_thermostats",
    {
      description:
        "List all registered Ecobee thermostats with their ID, name, and connection status.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => {
      const thermostats = await cache.getOrFetch("all:list", async () => {
        return api.getThermostats({
          selectionType: "registered",
          selectionMatch: "",
          includeRuntime: true,
        });
      });

      const result = thermostats.map((t) => ({
        id: t.identifier,
        name: t.name,
        connected: t.runtime?.connected ?? false,
        model: t.modelNumber,
      }));

      return structuredResult(outputSchema, { thermostats: result }, result);
    },
  );
}
