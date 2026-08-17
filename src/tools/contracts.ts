import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
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
  compileSchema,
  type Infer,
  type ObjectSchema,
  prepareSchemaValue,
  schema as s,
  type Schema,
} from "../schema.js";

export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const STRUCTURED_RESULT_TEXT =
  "Structured Ecobee result returned; use structuredContent for the complete validated data.";
const CALL_TOOL_RESULT_JSON_OVERHEAD_BYTES = Buffer.byteLength(
  '{"content":[{"type":"text","text":}],"structuredContent":}',
  "utf8",
);
export const MAX_THERMOSTATS = 64;
export const MAX_SENSORS = 128;
export const MAX_EVENTS = 256;
export const MAX_RUNTIME_ROWS = 9_000;

export const boundedString = (max = 512) => s.string().max(max);
export const thermostatIdSchema = boundedString(64)
  .min(1)
  .describe("Thermostat ID. Omit to use the first registered thermostat.");
export const optionalThermostatIdSchema = thermostatIdSchema.optional();
export const emptyInputSchema = s.object({});
export const optionalThermostatInputSchema = s.object({
  thermostatId: optionalThermostatIdSchema,
});
export const finiteNumber = s.number().finite().min(-1_000_000).max(1_000_000);
export const temperatureSchema = s.number().finite().min(-50).max(150);
export const dateSchema = s
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .max(10);
export const timeSchema = s
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .max(8);

export const thermostatControlStateSchema = s.object({
  connected: s.boolean().nullable(),
  hvacMode: boundedString(32).nullable(),
  desiredHeat: finiteNumber.nullable(),
  desiredCool: finiteNumber.nullable(),
  equipmentStatus: boundedString(512),
  activeEvents: s
    .array(
      s.object({
        type: boundedString(64),
        name: boundedString(128),
        climateRef: boundedString(64),
        running: s.boolean(),
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

export const mutationVerificationSchema = s.enum([
  "confirmed",
  "accepted",
  "unavailable",
]);

type AnyObjectSchema = ObjectSchema<Record<string, Schema<unknown>>>;

const cachedInputValidators = new WeakSet<StandardSchemaWithJSON>();
const cachedOutputValidators = new WeakSet<StandardSchemaWithJSON>();
const sdkValidatedInputs = new WeakSet<object>();
const locallyValidatedOutputs = new WeakSet<object>();

interface EcobeeToolConfig<
  InputSchema extends AnyObjectSchema,
  OutputSchema extends AnyObjectSchema,
> {
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  annotations: ToolAnnotations;
}

/**
 * Registers a built-in Ecobee tool with request-scoped cancellation and a
 * fixed public error boundary. Locally parsed output is marked so the SDK does
 * not repeat the same validation immediately before serialization.
 */
export function registerEcobeeTool<
  InputSchema extends AnyObjectSchema,
  OutputSchema extends AnyObjectSchema,
>(
  server: McpServer,
  api: EcobeeApiClient,
  name: string,
  config: EcobeeToolConfig<InputSchema, OutputSchema>,
  handler: (args: Infer<InputSchema>) => Promise<CallToolResult>,
): void {
  const sdkInputSchema = compileSchema(config.inputSchema);
  const sdkOutputSchema = compileSchema(config.outputSchema);
  markSdkValidatedInputs(sdkInputSchema);
  skipDuplicateOutputValidation(sdkOutputSchema);
  server.registerTool(
    name,
    {
      ...config,
      inputSchema: sdkInputSchema,
      outputSchema: sdkOutputSchema,
    },
    async (args, ctx) => {
      try {
        const validated = (
          typeof args === "object" &&
          args !== null &&
          sdkValidatedInputs.has(args)
            ? args
            : await validateSchema(sdkInputSchema, args)
        ) as Infer<InputSchema>;
        const parsed = prepareSchemaValue(config.inputSchema, validated);
        if (typeof api.withRequestSignal === "function") {
          return await api.withRequestSignal(ctx.mcpReq.signal, () =>
            handler(parsed),
          );
        }
        // Supports narrow injected fakes in unit tests. Production always uses
        // EcobeeApiClient and therefore takes the cancellation path.
        return await handler(parsed);
      } catch (error) {
        return toolError(publicToolError(error));
      }
    },
  );
}

function markSdkValidatedInputs(schema: StandardSchemaWithJSON): void {
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

function skipDuplicateOutputValidation(schema: StandardSchemaWithJSON): void {
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

export function structuredResult<OutputSchema extends AnyObjectSchema>(
  schema: OutputSchema,
  value: Infer<OutputSchema>,
  textContent?: string,
): CallToolResult {
  const validation = compileSchema(schema)["~standard"].validate(value);
  if (validation instanceof Promise) {
    throw new Error("Ecobee output schemas must validate synchronously.");
  }
  if ("issues" in validation) {
    throw new Error("Ecobee produced an invalid structured result.");
  }
  const parsed = validation.value as Record<string, unknown>;
  locallyValidatedOutputs.add(parsed);
  const text =
    typeof textContent === "string" ? textContent : STRUCTURED_RESULT_TEXT;
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: parsed,
  };
  const resultBytes = serializedResultBytes(text, parsed);
  if (resultBytes > MAX_TOOL_RESULT_BYTES) {
    throw new EcobeeResponseLimitError(MAX_TOOL_RESULT_BYTES);
  }

  return result;
}

function serializedResultBytes(
  text: string,
  structuredContent: Record<string, unknown>,
): number {
  return (
    CALL_TOOL_RESULT_JSON_OVERHEAD_BYTES +
    jsonByteLength(text) +
    jsonByteLength(structuredContent)
  );
}

/** Counts the exact UTF-8 bytes JSON.stringify would emit for JSON-safe data
 * without allocating a second full serialization of a tool result. */
export function jsonByteLength(value: unknown): number {
  return jsonValueBytes(value, new Set<object>());
}

function jsonValueBytes(value: unknown, ancestors: Set<object>): number {
  if (value === null) return 4;
  switch (typeof value) {
    case "string":
      return jsonStringBytes(value);
    case "number":
      return Number.isFinite(value)
        ? String(Object.is(value, -0) ? 0 : value).length
        : 4;
    case "boolean":
      return value ? 4 : 5;
    case "object":
      break;
    default:
      throw new TypeError("Value is not JSON serializable.");
  }

  if (ancestors.has(value)) throw new TypeError("Circular JSON value.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let bytes = 2;
      for (let index = 0; index < value.length; index++) {
        if (index > 0) bytes++;
        const entry = value[index];
        bytes +=
          entry === undefined ||
          typeof entry === "function" ||
          typeof entry === "symbol"
            ? 4
            : jsonValueBytes(entry, ancestors);
      }
      return bytes;
    }

    let bytes = 2;
    let entries = 0;
    const object = value as Record<string, unknown>;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      const entry = object[key];
      if (
        entry === undefined ||
        typeof entry === "function" ||
        typeof entry === "symbol"
      ) {
        continue;
      }
      if (entries++ > 0) bytes++;
      bytes += jsonStringBytes(key) + 1 + jsonValueBytes(entry, ancestors);
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

async function validateSchema(
  schema: StandardSchemaWithJSON,
  value: unknown,
): Promise<unknown> {
  const validation = await schema["~standard"].validate(value);
  if ("issues" in validation) throw new Error("Invalid tool input.");
  return validation.value;
}

export async function readControlState(
  api: EcobeeApiClient,
  thermostatId: string,
): Promise<Infer<typeof thermostatControlStateSchema> | null> {
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
): Promise<Infer<typeof thermostatControlStateSchema> | null> {
  try {
    return await readControlState(api, thermostatId);
  } catch {
    return null;
  }
}

export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message.slice(0, 512) }],
    isError: true,
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
