import { schema as s } from "../schema.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import {
  boundedString,
  finiteNumber,
  MAX_SENSORS,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const outputSchema = s.object({
  thermostatId: boundedString(64).nullable(),
  sensors: s
    .array(
      s.object({
        id: boundedString(64),
        name: boundedString(128),
        type: boundedString(64),
        inUse: s.boolean(),
        temperature: finiteNumber.optional(),
        humidity: finiteNumber.optional(),
        occupancy: s.boolean().optional(),
      }),
    )
    .max(MAX_SENSORS),
});

export function registerGetSensors(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_sensors",
    {
      description:
        "Get all remote sensor readings including temperature, humidity, and occupancy for a thermostat.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(`${id}:sensors`, async () => {
        return api.getThermostats({
          selectionType: thermostatId ? "thermostats" : "registered",
          selectionMatch: thermostatId ?? "",
          includeSensors: true,
        });
      });

      if (thermostats.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: null,
            sensors: [],
          },
          "No thermostats found.",
        );
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

      return structuredResult(outputSchema, {
        thermostatId: thermostats[0].identifier,
        sensors: result,
      });
    },
  );
}
