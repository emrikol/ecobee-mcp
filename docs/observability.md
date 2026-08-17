# Observability

Ecobee MCP includes opt-in OpenTelemetry tracing. The default path does not
load or instantiate the trace SDK or an exporter and takes a low-cost no-op
branch. Health output is unchanged apart from the already documented service
and protocol versions.

## Built-in exporter

The built-in option uses the OpenTelemetry Node tracer provider, parent-based
ratio sampling, a bounded batch processor, and the console exporter:

```bash
ECOBEE_TRACE_EXPORTER=console
ECOBEE_TRACE_SAMPLE_RATE=0.1
```

`ECOBEE_TRACE_SAMPLE_RATE` is clamped to `0` through `1` and defaults to `1`
when the console exporter is enabled. Production deployments should normally
choose a lower rate.

For an externally registered OpenTelemetry provider, load and register that
provider before this application, then set:

```bash
ECOBEE_TRACING_ENABLED=1
```

The application depends only on the official OpenTelemetry API and Node trace
SDK. It does not embed a vendor-specific backend or collector configuration.

## Trace topology

| Span                | Kind     | Purpose                                      |
| ------------------- | -------- | -------------------------------------------- |
| `mcp.request`       | Server   | One `/mcp` HTTP request                      |
| `mcp.server.create` | Internal | Per-request v2 server registration           |
| `mcp.tool`          | Internal | One built-in Ecobee tool invocation          |
| `ecobee.request`    | Client   | Queuing and one logical Ecobee API operation |

Traces include only bounded operational attributes: MCP method, negotiated
protocol, tool name, read-only classification, HTTP method/route/status, Ecobee
mutation classification, queue duration, retry flags, authentication state,
tool error state, and cache outcome/operation. They do not include arguments,
result bodies, thermostat IDs, URLs with query data, credentials, or error
messages.

The server accepts W3C `traceparent` and bounded `tracestate` values from modern
MCP request `_meta`. Invalid context is ignored. Stream-close cancellation
continues through the active tool and Ecobee request spans.

## Secret handling

Access tokens, refresh tokens, client secrets, authorization codes, API keys,
and Ecobee PINs are excluded from span attributes and events. Errors record
only a bounded error class, never an error message. Automated tests serialize
the exported spans and assert that injected secrets do not occur.

The console exporter writes complete span records to process output, so normal
log access controls and retention policies still apply. Do not add arbitrary
request or response data to span attributes.

## Performance diagnostics

Runtime tracing is intentionally separate from always-on production telemetry:

```bash
npm run profile:trace
```

This captures Node, V8, and async-hooks trace events plus sampled CPU and heap
profiles in `.artifacts/performance/`. See [Performance](performance.md) for the
benchmark scenarios, flamegraph generation, and interpretation guidance.
