import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";

export function registerGetSensors(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_sensors",
    {
      description:
        "Get all remote sensor readings including temperature, humidity, and occupancy for a thermostat.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe("Thermostat ID. Omit to use the first registered thermostat."),
      },
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(
        `${id}:sensors`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeSensors: true,
          });
        },
      );

      if (thermostats.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No thermostats found." },
          ],
        };
      }

      const sensors = thermostats[0].remoteSensors ?? [];

      const result = sensors.map((s) => {
        const caps: Record<string, string | number | boolean> = {};
        for (const cap of s.capability) {
          if (cap.type === "temperature" && cap.value !== "unknown") {
            caps.temperature = Number(cap.value) / 10; // 1/10 degree F
          } else if (cap.type === "humidity" && cap.value !== "unknown") {
            caps.humidity = Number(cap.value);
          } else if (cap.type === "occupancy") {
            caps.occupancy = cap.value === "true";
          }
        }

        return {
          id: s.id,
          name: s.name,
          type: s.type,
          inUse: s.inUse,
          ...caps,
        };
      });

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
