import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { toEcobeeTemp } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
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
    climateRef: boundedString(64).min(1).optional(),
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
    holdType: z
      .enum(["nextTransition", "indefinite"])
      .default("nextTransition"),
  })
  .refine(
    ({ climateRef, heatTemp, coolTemp }) =>
      climateRef !== undefined ||
      heatTemp !== undefined ||
      coolTemp !== undefined,
    { message: "A climateRef or temperature is required." },
  );

const outputSchema = z.object({
  thermostatId: z.string().min(1).max(64),
  requestedChange: z.object({
    climateRef: boundedString(64).optional(),
    heatTemp: temperatureSchema.optional(),
    coolTemp: temperatureSchema.optional(),
    holdType: z.enum(["nextTransition", "indefinite"]),
  }),
  resultingState: z.object({
    thermostat: thermostatControlStateSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerSetHold(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "set_hold",
    {
      description:
        'Hold a comfort profile (e.g., "away", "home", "sleep") or custom temperatures. Use climateRef for named profiles, or heatTemp/coolTemp for custom holds.',
      inputSchema,
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, climateRef, heatTemp, coolTemp, holdType }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.setHold(id, {
        holdType,
        ...(climateRef && { holdClimateRef: climateRef }),
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
        (coolTemp === undefined || state.desiredCool === coolTemp) &&
        (climateRef === undefined ||
          state.activeEvents.some(
            (event) => event.type === "hold" && event.climateRef === climateRef,
          ));
      return structuredResult(outputSchema, {
        thermostatId: id,
        requestedChange: {
          ...(climateRef && { climateRef }),
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
