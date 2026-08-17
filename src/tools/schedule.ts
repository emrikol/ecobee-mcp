import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import {
  boundedString,
  finiteNumber,
  optionalThermostatIdSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
} from "./contracts.js";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const outputSchema = z.object({
  thermostatId: boundedString(64).nullable(),
  program: z
    .object({
      currentClimate: boundedString(64),
      climates: z
        .array(
          z.object({
            name: boundedString(128),
            ref: boundedString(64),
            type: boundedString(64),
            heatTemp: finiteNumber,
            coolTemp: finiteNumber,
            isOccupied: z.boolean(),
          }),
        )
        .max(64),
      schedule: z
        .array(
          z.object({
            day: z.enum([
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ]),
            periods: z.array(boundedString(64)).max(48),
          }),
        )
        .max(7),
    })
    .nullable(),
});

export function registerGetSchedule(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_schedule",
    {
      description:
        "Get the thermostat's program schedule, comfort profiles (home/away/sleep), and current climate.",
      inputSchema: z.object({ thermostatId: optionalThermostatIdSchema }),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ thermostatId }) => {
      const id = thermostatId ?? "first";

      const thermostats = await cache.getOrFetch(`${id}:schedule`, async () => {
        return api.getThermostats({
          selectionType: thermostatId ? "thermostats" : "registered",
          selectionMatch: thermostatId ?? "",
          includeProgram: true,
        });
      });

      if (thermostats.length === 0) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: null,
            program: null,
          },
          "No thermostats found.",
        );
      }

      const program = thermostats[0].program;
      if (!program) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: thermostats[0].identifier,
            program: null,
          },
          "No program data available.",
        );
      }

      const result = {
        currentClimate: program.currentClimateRef,
        climates: program.climates.map((c) => ({
          name: c.name,
          ref: c.climateRef,
          type: c.type,
          heatTemp: fromEcobeeTemp(c.heatTemp),
          coolTemp: fromEcobeeTemp(c.coolTemp),
          isOccupied: c.isOccupied,
        })),
        schedule: program.schedule.map((day, i) => ({
          day: DAY_NAMES[i],
          periods: day,
        })),
      };

      return structuredResult(
        outputSchema,
        {
          thermostatId: thermostats[0].identifier,
          program: result,
        },
        result,
      );
    },
  );
}
