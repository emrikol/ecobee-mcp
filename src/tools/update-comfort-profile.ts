import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp, fromEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  mutationAnnotations,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  registerEcobeeTool,
  structuredResult,
  temperatureSchema,
} from "./contracts.js";

const inputSchema = z
  .object({
    thermostatId: optionalThermostatIdSchema,
    climateRef: boundedString(64).min(1),
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
  })
  .refine(
    ({ heatTemp, coolTemp }) =>
      heatTemp !== undefined || coolTemp !== undefined,
    { message: "At least one temperature is required." },
  );

const profileStateSchema = z.object({
  climateRef: boundedString(64),
  heatTemp: temperatureSchema,
  coolTemp: temperatureSchema,
});

const outputSchema = z.object({
  thermostatId: boundedString(64),
  requestedChange: z.object({
    climateRef: boundedString(64),
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
  }),
  previousState: profileStateSchema,
  resultingState: z.object({
    profile: profileStateSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerUpdateComfortProfile(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "update_comfort_profile",
    {
      description:
        'Permanently update the temperature set points for a comfort profile (e.g., "home", "away", "sleep"). This changes the schedule defaults, not a temporary hold.',
      inputSchema,
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, climateRef, heatTemp, coolTemp }) => {
      const id = await resolveId(thermostatId, api, cache);

      // Fetch current to show before/after
      const before = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeProgram: true,
      });

      const climate = before[0]?.program?.climates.find(
        (c) => c.climateRef === climateRef,
      );

      if (!climate) {
        /* v8 ignore next 3 */
        const available =
          before[0]?.program?.climates.map((c) => c.climateRef).join(", ") ??
          "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Climate "${climateRef}" not found. Available: ${available}`,
            },
          ],
          isError: true,
        };
      }

      const oldHeat = fromEcobeeTemp(climate.heatTemp);
      const oldCool = fromEcobeeTemp(climate.coolTemp);

      await api.updateComfortProfile(id, climateRef, {
        ...(heatTemp !== undefined && { heatTemp: toEcobeeTemp(heatTemp) }),
        ...(coolTemp !== undefined && { coolTemp: toEcobeeTemp(coolTemp) }),
      });

      cache.invalidate(id);

      const after = await api
        .getThermostats({
          selectionType: "thermostats",
          selectionMatch: id,
          includeProgram: true,
        })
        .catch(() => []);
      const resultingClimate = after[0]?.program?.climates.find(
        (item) => item.climateRef === climateRef,
      );
      const resultingProfile = resultingClimate
        ? {
            climateRef,
            heatTemp: fromEcobeeTemp(resultingClimate.heatTemp),
            coolTemp: fromEcobeeTemp(resultingClimate.coolTemp),
          }
        : null;
      const confirmed =
        resultingProfile !== null &&
        (heatTemp === undefined || resultingProfile.heatTemp === heatTemp) &&
        (coolTemp === undefined || resultingProfile.coolTemp === coolTemp);

      return structuredResult(
        outputSchema,
        {
          thermostatId: id,
          requestedChange: {
            climateRef,
            ...(heatTemp !== undefined && { heatTemp }),
            ...(coolTemp !== undefined && { coolTemp }),
          },
          previousState: { climateRef, heatTemp: oldHeat, coolTemp: oldCool },
          resultingState: {
            profile: resultingProfile,
            verification: !resultingProfile
              ? "unavailable"
              : confirmed
                ? "confirmed"
                : "accepted",
          },
        },
        `Updated "${climateRef}" profile on ${id}: ${[
          heatTemp !== undefined ? `heat: ${oldHeat}°F → ${heatTemp}°F` : "",
          coolTemp !== undefined ? `cool: ${oldCool}°F → ${coolTemp}°F` : "",
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
    },
  );
}
