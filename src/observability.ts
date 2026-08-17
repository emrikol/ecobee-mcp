import {
  context,
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { SERVICE_NAME, SERVICE_VERSION } from "./constants.js";

const TRACEPARENT_PATTERN =
  /^(?!ff)[\da-f]{2}-(?!0{32})[\da-f]{32}-(?!0{16})[\da-f]{16}-[\da-f]{2}$/i;
const MAX_TRACESTATE_LENGTH = 512;
const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const noOpSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
let instrumentationEnabled = process.env.ECOBEE_TRACING_ENABLED === "1";

export interface TracingController {
  enabled: boolean;
  shutdown: () => Promise<void>;
}

export interface SpanOptions {
  attributes?: Attributes;
  kind?: SpanKind;
  parent?: Context;
}

/**
 * Enable the built-in batched console exporter only when explicitly asked.
 * When disabled, instrumentation remains compatible with an externally
 * registered OpenTelemetry SDK and is otherwise a low-cost no-op.
 */
export async function configureTracing(): Promise<TracingController> {
  instrumentationEnabled ||= process.env.ECOBEE_TRACING_ENABLED === "1";
  if (process.env.ECOBEE_TRACE_EXPORTER !== "console") {
    return {
      enabled: instrumentationEnabled,
      shutdown: async () => undefined,
    };
  }

  instrumentationEnabled = true;
  const {
    BatchSpanProcessor,
    ConsoleSpanExporter,
    NodeTracerProvider,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = await import("@opentelemetry/sdk-trace-node");
  const provider = new NodeTracerProvider({
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(traceSampleRate()),
    }),
    spanProcessors: [
      new BatchSpanProcessor(new ConsoleSpanExporter(), {
        maxQueueSize: 2_048,
        maxExportBatchSize: 256,
        scheduledDelayMillis: 1_000,
        exportTimeoutMillis: 5_000,
      }),
    ],
  });
  provider.register();
  return {
    enabled: true,
    shutdown: () => provider.shutdown(),
  };
}

export function traceOperation<T>(
  name: string,
  options: SpanOptions,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  if (!instrumentationEnabled) return operation(noOpSpan);
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { attributes: options.attributes, kind: options.kind },
    parent,
    async (span) => {
      try {
        return await operation(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function traceSync<T>(
  name: string,
  attributes: Attributes,
  operation: () => T,
): T {
  if (!instrumentationEnabled) return operation();
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      return operation();
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function activeSpan(): Span | undefined {
  if (!instrumentationEnabled) return undefined;
  return trace.getActiveSpan();
}

export function isTracingEnabled(): boolean {
  return instrumentationEnabled;
}

/** Record only an error class, never a potentially secret-bearing message. */
export function recordSpanError(span: Span, error: unknown): void {
  span.setAttribute("error.type", safeErrorType(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Extract only validated W3C trace context from untrusted MCP metadata. */
export function extractMcpTraceContext(body: unknown): Context {
  const meta = requestMeta(body);
  if (!meta) return ROOT_CONTEXT;
  const traceparent = meta.traceparent;
  if (
    typeof traceparent !== "string" ||
    !TRACEPARENT_PATTERN.test(traceparent)
  ) {
    return ROOT_CONTEXT;
  }
  const carrier: Record<string, string> = { traceparent };
  if (
    typeof meta.tracestate === "string" &&
    meta.tracestate.length <= MAX_TRACESTATE_LENGTH
  ) {
    carrier.tracestate = meta.tracestate;
  }
  return propagation.extract(ROOT_CONTEXT, carrier);
}

export function mcpMethod(body: unknown): string {
  if (typeof body !== "object" || body === null || !("method" in body)) {
    return "unknown";
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" && /^[a-z][a-z0-9_/-]{0,63}$/i.test(method)
    ? method
    : "unknown";
}

function requestMeta(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || !("params" in body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || !("_meta" in params)) {
    return undefined;
  }
  const meta = (params as { _meta?: unknown })._meta;
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : undefined;
}

function traceSampleRate(): number {
  const parsed = Number(process.env.ECOBEE_TRACE_SAMPLE_RATE ?? "1");
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error";
}
