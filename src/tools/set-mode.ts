import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  mutationAnnotations,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  reconcileControlState,
  registerEcobeeTool,
  structuredResult,
  thermostatControlStateSchema,
} from "./contracts.js";

const modeSchema = z.enum(["heat", "cool", "auto", "off", "auxHeatOnly"]);
const inputSchema = z.object({
  thermostatId: optionalThermostatIdSchema,
  mode: modeSchema.describe("The HVAC mode to set"),
});
const outputSchema = z.object({
  thermostatId: z.string().min(1).max(64),
  requestedChange: z.object({ mode: modeSchema }),
  resultingState: z.object({
    thermostat: thermostatControlStateSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerSetMode(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "set_hvac_mode",
    {
      description:
        "Change the thermostat's HVAC mode (heat, cool, auto, off, or auxHeatOnly).",
      inputSchema,
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ thermostatId, mode }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.setHvacMode(id, mode);
      cache.invalidate(id);

      const state = await reconcileControlState(api, id);
      return structuredResult(outputSchema, {
        thermostatId: id,
        requestedChange: { mode },
        resultingState: {
          thermostat: state,
          verification: !state
            ? "unavailable"
            : state.hvacMode === mode
              ? "confirmed"
              : "accepted",
        },
      });
    },
  );
}
