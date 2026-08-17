import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  destructiveMutationAnnotations,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  reconcileControlState,
  registerEcobeeTool,
  structuredResult,
  thermostatControlStateSchema,
} from "./contracts.js";

const inputSchema = z.object({
  thermostatId: optionalThermostatIdSchema,
  resumeAll: z
    .boolean()
    .default(false)
    .describe("If true, removes all events including vacation holds."),
});

const outputSchema = z.object({
  thermostatId: z.string().min(1).max(64),
  requestedChange: z.object({ resumeAll: z.boolean() }),
  resultingState: z.object({
    thermostat: thermostatControlStateSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerResumeSchedule(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "resume_schedule",
    {
      description:
        "Cancel any active hold and resume the normal thermostat program schedule.",
      inputSchema,
      outputSchema,
      annotations: destructiveMutationAnnotations,
    },
    async ({ thermostatId, resumeAll }) => {
      const id = await resolveId(thermostatId, api, cache);

      await api.resumeProgram(id, resumeAll);
      cache.invalidate(id);

      const state = await reconcileControlState(api, id);
      const confirmed =
        state !== null &&
        !state.activeEvents.some(
          (event) =>
            event.type === "hold" || (resumeAll && event.type === "vacation"),
        );
      return structuredResult(
        outputSchema,
        {
          thermostatId: id,
          requestedChange: { resumeAll },
          resultingState: {
            thermostat: state,
            verification: !state
              ? "unavailable"
              : confirmed
                ? "confirmed"
                : "accepted",
          },
        },
        `Schedule resumed on thermostat ${id}${resumeAll ? " (all events cleared)" : ""}.`,
      );
    },
  );
}
