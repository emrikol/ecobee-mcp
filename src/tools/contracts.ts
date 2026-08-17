import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
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
import { recordSpanError, traceOperation } from "../observability.js";

export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const CALL_TOOL_RESULT_JSON_OVERHEAD_BYTES = Buffer.byteLength(
  '{"content":[{"type":"text","text":}],"structuredContent":}',
  "utf8",
);
export const MAX_THERMOSTATS = 64;
export const MAX_SENSORS = 128;
export const MAX_EVENTS = 256;
export const MAX_RUNTIME_ROWS = 9_000;

export const boundedString = (max = 512) => z.string().max(max);
export const thermostatIdSchema = boundedString(64)
  .min(1)
  .describe("Thermostat ID. Omit to use the first registered thermostat.");
export const optionalThermostatIdSchema = thermostatIdSchema.optional();
export const emptyInputSchema = z.object({});
export const optionalThermostatInputSchema = z.object({
  thermostatId: optionalThermostatIdSchema,
});
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

const strictInputSchemas = new WeakMap<ObjectSchema, ObjectSchema>();
const cachedJsonSchemas = new WeakSet<ObjectSchema>();
const cachedInputValidators = new WeakSet<ObjectSchema>();
const cachedOutputValidators = new WeakSet<ObjectSchema>();
const sdkValidatedInputs = new WeakSet<object>();
const locallyValidatedOutputs = new WeakSet<object>();

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
 * fixed, secret-safe error boundary. Locally parsed output is marked so the
 * SDK does not repeat the same validation immediately before serialization.
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
  const sdkInputSchema: z.ZodObject = strictInputSchema(config.inputSchema);
  const sdkOutputSchema: z.ZodObject = config.outputSchema;
  cacheJsonSchema(sdkInputSchema);
  cacheJsonSchema(sdkOutputSchema);
  markSdkValidatedInputs(sdkInputSchema);
  skipDuplicateOutputValidation(sdkOutputSchema);
  server.registerTool(
    name,
    {
      ...config,
      inputSchema: sdkInputSchema,
      outputSchema: sdkOutputSchema,
    },
    async (args, ctx) =>
      traceOperation(
        "mcp.tool",
        {
          attributes: {
            "mcp.tool.name": name,
            "mcp.tool.read_only": config.annotations.readOnlyHint === true,
          },
        },
        async (span) => {
          try {
            const parsed = (
              typeof args === "object" &&
              args !== null &&
              sdkValidatedInputs.has(args)
                ? args
                : await sdkInputSchema.parseAsync(args)
            ) as z.output<InputSchema>;
            if (typeof api.withRequestSignal === "function") {
              const result = await api.withRequestSignal(
                ctx.mcpReq.signal,
                () => handler(parsed),
              );
              span.setAttribute("mcp.tool.error", result.isError === true);
              return sanitizeToolResult(result);
            }
            // Supports narrow injected fakes in unit tests. Production always
            // uses EcobeeApiClient and therefore takes the cancellation path.
            const result = await handler(parsed);
            span.setAttribute("mcp.tool.error", result.isError === true);
            return sanitizeToolResult(result);
          } catch (error) {
            recordSpanError(span, error);
            span.setAttribute("mcp.tool.error", true);
            return toolError(publicToolError(error));
          }
        },
      ),
  );
}

/**
 * The v2 HTTP adapter creates a fresh McpServer per request. Zod's Standard
 * Schema converter otherwise rebuilds every tool's JSON Schema for every
 * tools/list and tools/call request. Keep Zod validation semantics while
 * memoizing only the immutable draft schemas shared by all server instances.
 */
function cacheJsonSchema(schema: ObjectSchema): void {
  if (cachedJsonSchemas.has(schema)) return;

  const standard = (schema as unknown as StandardSchemaWithJSON)["~standard"];
  const inputByTarget = new Map<string, Record<string, unknown>>();
  const outputByTarget = new Map<string, Record<string, unknown>>();
  const cacheKey = (options: { target: string }) => options.target;
  const originalConverter = standard.jsonSchema;
  Object.defineProperty(standard, "jsonSchema", {
    configurable: true,
    enumerable: true,
    value: {
      input: (options: Parameters<typeof originalConverter.input>[0]) => {
        if (options.libraryOptions !== undefined) {
          return originalConverter.input(options);
        }
        const key = cacheKey(options);
        let converted = inputByTarget.get(key);
        if (!converted) {
          converted = originalConverter.input(options);
          inputByTarget.set(key, converted);
        }
        return converted;
      },
      output: (options: Parameters<typeof originalConverter.output>[0]) => {
        if (options.libraryOptions !== undefined) {
          return originalConverter.output(options);
        }
        const key = cacheKey(options);
        let converted = outputByTarget.get(key);
        if (!converted) {
          converted = originalConverter.output(options);
          outputByTarget.set(key, converted);
        }
        return converted;
      },
    },
    writable: true,
  });
  cachedJsonSchemas.add(schema);
}

function markSdkValidatedInputs(schema: ObjectSchema): void {
  if (cachedInputValidators.has(schema)) return;
  const standard = (schema as unknown as StandardSchemaWithJSON)["~standard"];
  const originalValidate = standard.validate;
  Object.defineProperty(standard, "validate", {
    configurable: true,
    enumerable: true,
    value: (value: unknown, options: unknown) => {
      const result = originalValidate(value, options as never);
      return result instanceof Promise
        ? result.then(markValidatedInput)
        : markValidatedInput(result);
    },
    writable: true,
  });
  cachedInputValidators.add(schema);
}

function markValidatedInput<Result>(result: Result): Result {
  if (
    typeof result === "object" &&
    result !== null &&
    "value" in result &&
    typeof result.value === "object" &&
    result.value !== null
  ) {
    sdkValidatedInputs.add(result.value);
  }
  return result;
}

function skipDuplicateOutputValidation(schema: ObjectSchema): void {
  if (cachedOutputValidators.has(schema)) return;
  const standard = (schema as unknown as StandardSchemaWithJSON)["~standard"];
  const originalValidate = standard.validate;
  Object.defineProperty(standard, "validate", {
    configurable: true,
    enumerable: true,
    value: (value: unknown, options: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        locallyValidatedOutputs.has(value)
      ) {
        return { value };
      }
      return originalValidate(value, options as never);
    },
    writable: true,
  });
  cachedOutputValidators.add(schema);
}

function strictInputSchema<Schema extends ObjectSchema>(
  schema: Schema,
): Schema {
  const existing = strictInputSchemas.get(schema);
  if (existing) return existing as Schema;
  const strict = schema.strict() as Schema;
  strictInputSchemas.set(schema, strict);
  return strict;
}

export function structuredResult<Schema extends ObjectSchema>(
  schema: Schema,
  value: z.input<Schema>,
  textContent?: unknown,
): CallToolResult {
  const parsed = schema.parse(value) as Record<string, unknown>;
  locallyValidatedOutputs.add(parsed);
  const structuredJson = JSON.stringify(parsed);
  let text =
    typeof textContent === "string"
      ? textContent
      : textContent == null
        ? structuredJson
        : (JSON.stringify(textContent) ?? structuredJson);
  let result: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: parsed,
  };
  let resultBytes = serializedResultBytes(text, structuredJson);
  if (resultBytes > MAX_TOOL_RESULT_BYTES && typeof textContent !== "string") {
    text =
      "Structured Ecobee result returned; use structuredContent for the complete validated data.";
    result = {
      content: [{ type: "text", text }],
      structuredContent: parsed,
    };
    resultBytes = serializedResultBytes(text, structuredJson);
  }
  if (resultBytes > MAX_TOOL_RESULT_BYTES) {
    throw new EcobeeResponseLimitError(MAX_TOOL_RESULT_BYTES);
  }

  return result;
}

function serializedResultBytes(text: string, structuredJson: string): number {
  return (
    CALL_TOOL_RESULT_JSON_OVERHEAD_BYTES +
    Buffer.byteLength(JSON.stringify(text), "utf8") +
    Buffer.byteLength(structuredJson, "utf8")
  );
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
