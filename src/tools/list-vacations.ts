import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import {
  boundedString,
  finiteNumber,
  MAX_EVENTS,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const vacationSchema = z.object({
  name: boundedString(64),
  running: z.boolean(),
  startDate: boundedString(10),
  startTime: boundedString(8),
  endDate: boundedString(10),
  endTime: boundedString(8),
  heatTemp: finiteNumber,
  coolTemp: finiteNumber,
  fan: boundedString(32),
});

const outputSchema = z.object({
  thermostatId: boundedString(64).nullable(),
  vacations: z.array(vacationSchema).max(MAX_EVENTS),
});

export function registerListVacations(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "list_vacations",
    {
      description:
        "List all scheduled vacation events for a thermostat, including dates, temperatures, and whether currently running.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(
        `${id}:vacations`,
        async () => {
          return api.getThermostats({
            selectionType: thermostatId ? "thermostats" : "registered",
            selectionMatch: thermostatId ?? "",
            includeEvents: true,
          });
        },
      );

      if (thermostats.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: null,
            vacations: [],
          },
          "No thermostats found.",
        );
      }

      const events = thermostats[0].events ?? [];
      const vacations = events
        .filter((e) => e.type === "vacation")
        .map((e) => ({
          name: e.name,
          running: e.running,
          startDate: e.startDate,
          startTime: e.startTime,
          endDate: e.endDate,
          endTime: e.endTime,
          heatTemp: fromEcobeeTemp(e.heatHoldTemp),
          coolTemp: fromEcobeeTemp(e.coolHoldTemp),
          fan: e.fan,
        }));

      return structuredResult(
        outputSchema,
        {
          thermostatId: thermostats[0].identifier,
          vacations,
        },
        vacations.length > 0 ? vacations : "No vacation events scheduled.",
      );
    },
  );
}
