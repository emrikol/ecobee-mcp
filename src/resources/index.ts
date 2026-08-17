import type { McpServer } from "@modelcontextprotocol/server";

/* v8 ignore start -- Integration test: MCP resource handlers.
   Test by reading ecobee://thermostat/status, ecobee://thermostat/sensors,
   and ecobee://thermostat/weather through an MCP client session. Verify
   data shape, temperature conversion, and on-demand cache behavior. */
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import { registerEcobeeResource } from "./register.js";

/**
 * Register all MCP resources.
 */
export function registerAllResources(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  // Thermostat status resource
  registerEcobeeResource(
    server,
    api,
    "thermostat_status",
    "ecobee://thermostat/status",
    { description: "Current thermostat state (on-demand fetch)" },
    async () => {
      const thermostats = await cache.getOrFetch("first:status", async () => {
        return api.getThermostats({
          selectionType: "registered",
          selectionMatch: "",
          includeRuntime: true,
          includeSettings: true,
          includeEvents: true,
          includeEquipmentStatus: true,
        });
      });

      const data = thermostats.map((t) => ({
        id: t.identifier,
        name: t.name,
        connected: t.runtime?.connected,
        temperature: t.runtime
          ? fromEcobeeTemp(t.runtime.actualTemperature)
          : null,
        humidity: t.runtime?.actualHumidity,
        hvacMode: t.settings?.hvacMode,
        desiredHeat: t.runtime ? fromEcobeeTemp(t.runtime.desiredHeat) : null,
        desiredCool: t.runtime ? fromEcobeeTemp(t.runtime.desiredCool) : null,
        equipmentStatus: t.equipmentStatus,
      }));

      return {
        contents: [
          {
            uri: "ecobee://thermostat/status",
            mimeType: "application/json",
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );

  // Sensor data resource
  registerEcobeeResource(
    server,
    api,
    "thermostat_sensors",
    "ecobee://thermostat/sensors",
    { description: "Remote sensor data (on-demand fetch)" },
    async () => {
      const thermostats = await cache.getOrFetch("first:sensors", async () => {
        return api.getThermostats({
          selectionType: "registered",
          selectionMatch: "",
          includeSensors: true,
        });
      });

      const sensors = thermostats.flatMap((t) =>
        (t.remoteSensors ?? []).map((s) => {
          const caps: Record<string, unknown> = {};
          for (const cap of s.capability) {
            if (cap.type === "temperature" && cap.value !== "unknown") {
              caps.temperature = Number(cap.value) / 10;
            } else if (cap.type === "humidity" && cap.value !== "unknown") {
              caps.humidity = Number(cap.value);
            } else if (cap.type === "occupancy") {
              caps.occupancy = cap.value === "true";
            }
          }
          return {
            thermostat: t.identifier,
            id: s.id,
            name: s.name,
            type: s.type,
            ...caps,
          };
        }),
      );

      return {
        contents: [
          {
            uri: "ecobee://thermostat/sensors",
            mimeType: "application/json",
            text: JSON.stringify(sensors),
          },
        ],
      };
    },
  );

  // Weather resource
  registerEcobeeResource(
    server,
    api,
    "thermostat_weather",
    "ecobee://thermostat/weather",
    { description: "Weather data from thermostat's station (on-demand fetch)" },
    async () => {
      const thermostats = await cache.getOrFetch("first:weather", async () => {
        return api.getThermostats({
          selectionType: "registered",
          selectionMatch: "",
          includeWeather: true,
        });
      });

      const weather = thermostats
        .filter((t) => t.weather)
        .map((t) => ({
          thermostat: t.identifier,
          station: t.weather!.weatherStation,
          forecasts: t.weather!.forecasts.map((f) => ({
            dateTime: f.dateTime,
            condition: f.condition,
            temperature: fromEcobeeTemp(f.temperature),
            humidity: f.relativeHumidity,
            windSpeed: f.windSpeed,
          })),
        }));

      return {
        contents: [
          {
            uri: "ecobee://thermostat/weather",
            mimeType: "application/json",
            text: JSON.stringify(weather),
          },
        ],
      };
    },
  );
}
