import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp } from "../ecobee/types.js";
import {
  mutationAnnotations,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  reconcileControlState,
  registerEcobeeTool,
  structuredResult,
  temperatureSchema,
  thermostatControlStateSchema,
} from "./contracts.js";

const inputSchema = z
  .object({
    thermostatId: optionalThermostatIdSchema,
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
    holdType: z
      .enum(["nextTransition", "indefinite"])
      .default("nextTransition"),
  })
  .refine(
    ({ heatTemp, coolTemp }) =>
      heatTemp !== undefined || coolTemp !== undefined,
    { message: "At least one of heatTemp or coolTemp is required." },
  );

const outputSchema = z.object({
  thermostatId: z.string().min(1).max(64),
  requestedChange: z.object({
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
    holdType: z.enum(["nextTransition", "indefinite"]),
  }),
  resultingState: z.object({
    thermostat: thermostatControlStateSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerSetTemperature(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "set_temperature",
    {
      description:
        "Set a temperature hold on the thermostat. Specify heat and/or cool set points in degrees F.",
      inputSchema,
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, heatTemp, coolTemp, holdType }) => {
      // Resolve thermostat ID if not provided
      const id = await resolveId(thermostatId, api, cache);

      await api.setHold(id, {
        holdType,
        ...(heatTemp !== undefined && {
          heatHoldTemp: toEcobeeTemp(heatTemp),
        }),
        ...(coolTemp !== undefined && {
          coolHoldTemp: toEcobeeTemp(coolTemp),
        }),
      });

      cache.invalidate(id);

      const state = await reconcileControlState(api, id);
      const confirmed =
        state !== null &&
        (heatTemp === undefined || state.desiredHeat === heatTemp) &&
        (coolTemp === undefined || state.desiredCool === coolTemp);
      return structuredResult(outputSchema, {
        thermostatId: id,
        requestedChange: {
          ...(heatTemp !== undefined && { heatTemp }),
          ...(coolTemp !== undefined && { coolTemp }),
          holdType,
        },
        resultingState: {
          thermostat: state,
          verification: !state
            ? "unavailable"
            : confirmed
              ? "confirmed"
              : "accepted",
        },
      });
    },
  );
}

/** Helper to resolve thermostat ID, defaulting to first registered. */
export async function resolveId(
  thermostatId: string | undefined,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): Promise<string> {
  if (thermostatId) return thermostatId;

  const thermostats = await cache.getOrFetch("all:list", async () => {
    return api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
      includeRuntime: true,
    });
  });

  if (thermostats.length === 0) {
    throw new Error("No thermostats found");
  }

  return thermostats[0].identifier;
}
