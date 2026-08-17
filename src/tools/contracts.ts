import type {
  CallToolResult,
  McpServer,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { EcobeeApiClient } from "../ecobee/api.js";
import {
  AmbiguousMutationDeliveryError,
  EcobeeApiError,
  EcobeeRateLimitError,
  EcobeeResponseLimitError,
  EcobeeTimeoutError,
} from "../ecobee/api.js";
import { fromEcobeeTemp } from "../ecobee/types.js";
import {
  redactSecrets,
  redactStructuredSecrets,
} from "../security/redaction.js";

export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
export const MAX_THERMOSTATS = 64;
export const MAX_SENSORS = 128;
export const MAX_EVENTS = 256;
export const MAX_RUNTIME_ROWS = 9_000;

export const boundedString = (max = 512) => z.string().max(max);
export const thermostatIdSchema = boundedString(64)
  .min(1)
  .describe("Thermostat ID. Omit to use the first registered thermostat.");
export const optionalThermostatIdSchema = thermostatIdSchema.optional();
export const finiteNumber = z.number().finite().min(-1_000_000).max(1_000_000);
export const temperatureSchema = z.number().finite().min(-50).max(150);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .max(10);
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .max(8);

export const thermostatControlStateSchema = z.object({
  connected: z.boolean().nullable(),
  hvacMode: boundedString(32).nullable(),
  desiredHeat: finiteNumber.nullable(),
  desiredCool: finiteNumber.nullable(),
  equipmentStatus: boundedString(512),
  activeEvents: z
    .array(
      z.object({
        type: boundedString(64),
        name: boundedString(128),
        climateRef: boundedString(64),
        running: z.boolean(),
        heatTemp: finiteNumber,
        coolTemp: finiteNumber,
        endDate: boundedString(10),
        endTime: boundedString(8),
      }),
    )
    .max(MAX_EVENTS),
});

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const mutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const destructiveMutationAnnotations: ToolAnnotations = {
  ...mutationAnnotations,
  destructiveHint: true,
};

export const mutationVerificationSchema = z.enum([
  "confirmed",
  "accepted",
  "unavailable",
]);

type ObjectSchema = z.ZodObject;

interface EcobeeToolConfig<
  InputSchema extends ObjectSchema,
  OutputSchema extends ObjectSchema,
> {
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  annotations: ToolAnnotations;
}

/**
 * Registers a built-in Ecobee tool with request-scoped cancellation and a
 * fixed, secret-safe error boundary. The SDK performs an additional output
 * validation pass before serializing a successful result.
 */
export function registerEcobeeTool<
  InputSchema extends ObjectSchema,
  OutputSchema extends ObjectSchema,
>(
  server: McpServer,
  api: EcobeeApiClient,
  name: string,
  config: EcobeeToolConfig<InputSchema, OutputSchema>,
  handler: (args: z.output<InputSchema>) => Promise<CallToolResult>,
): void {
  const sdkInputSchema: z.ZodObject = config.inputSchema.strict();
  const sdkOutputSchema: z.ZodObject = config.outputSchema;
  server.registerTool(
    name,
    { ...config, inputSchema: sdkInputSchema, outputSchema: sdkOutputSchema },
    async (args, ctx) => {
      try {
        const parsed = (await sdkInputSchema.parseAsync(
          args,
        )) as z.output<InputSchema>;
        if (typeof api.withRequestSignal === "function") {
          const result = await api.withRequestSignal(ctx.mcpReq.signal, () =>
            handler(parsed),
          );
          return sanitizeToolResult(result);
        }
        // Supports narrow injected fakes in unit tests. Production always uses
        // EcobeeApiClient and therefore always takes the cancellation path.
        return sanitizeToolResult(await handler(parsed));
      } catch (error) {
        return toolError(publicToolError(error));
      }
    },
  );
}

export function structuredResult<Schema extends ObjectSchema>(
  schema: Schema,
  value: z.input<Schema>,
  textContent?: unknown,
): CallToolResult {
  const parsed = schema.parse(value) as Record<string, unknown>;
  const text =
    typeof textContent === "string"
      ? textContent
      : JSON.stringify(textContent ?? parsed, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new EcobeeResponseLimitError(MAX_TOOL_RESULT_BYTES);
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: parsed,
  };
}

export async function readControlState(
  api: EcobeeApiClient,
  thermostatId: string,
): Promise<z.output<typeof thermostatControlStateSchema> | null> {
  const thermostats = await api.getThermostats({
    selectionType: "thermostats",
    selectionMatch: thermostatId,
    includeRuntime: true,
    includeSettings: true,
    includeEvents: true,
    includeEquipmentStatus: true,
  });
  const thermostat = thermostats[0];
  if (!thermostat) return null;

  return {
    connected: thermostat.runtime?.connected ?? null,
    hvacMode: thermostat.settings?.hvacMode ?? null,
    desiredHeat: thermostat.runtime
      ? fromEcobeeTemp(thermostat.runtime.desiredHeat)
      : null,
    desiredCool: thermostat.runtime
      ? fromEcobeeTemp(thermostat.runtime.desiredCool)
      : null,
    equipmentStatus: thermostat.equipmentStatus ?? "",
    activeEvents: (thermostat.events ?? [])
      .filter((event) => event.running)
      .slice(0, MAX_EVENTS)
      .map((event) => ({
        type: event.type,
        name: event.name,
        climateRef: event.holdClimateRef ?? "",
        running: event.running,
        heatTemp: fromEcobeeTemp(event.heatHoldTemp),
        coolTemp: fromEcobeeTemp(event.coolHoldTemp),
        endDate: event.endDate,
        endTime: event.endTime,
      })),
  };
}

/** A completed mutation should not become a retry-provoking tool error merely
 * because its best-effort reconciliation read failed. */
export async function reconcileControlState(
  api: EcobeeApiClient,
  thermostatId: string,
): Promise<z.output<typeof thermostatControlStateSchema> | null> {
  try {
    return await readControlState(api, thermostatId);
  } catch {
    return null;
  }
}

export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: redactSecrets(message).slice(0, 512) }],
    isError: true,
  };
}

function sanitizeToolResult(result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: result.content.map((content) =>
      content.type === "text"
        ? { ...content, text: redactSecrets(content.text) }
        : content,
    ),
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: redactStructuredSecrets(
            result.structuredContent,
          ) as Record<string, unknown>,
        }),
  };
}

function publicToolError(error: unknown): string {
  if (error instanceof AmbiguousMutationDeliveryError) {
    return "Mutation delivery is ambiguous; the operation was not retried. Read the thermostat state before deciding whether to retry.";
  }
  if (error instanceof EcobeeRateLimitError) {
    return "Ecobee rate limit reached. Try the read again later; mutations are never retried automatically.";
  }
  if (error instanceof EcobeeTimeoutError) {
    return "Ecobee request deadline exceeded.";
  }
  if (error instanceof EcobeeResponseLimitError) {
    return "Ecobee response exceeded the configured size limit.";
  }
  if (error instanceof EcobeeApiError) {
    return `Ecobee rejected the request (HTTP ${error.httpStatus}${
      error.ecobeeCode === undefined ? "" : `, code ${error.ecobeeCode}`
    }).`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Request cancelled.";
  }
  return "Ecobee operation failed.";
}
