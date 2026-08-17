# Development diagnostics

Production contains no telemetry instrumentation, trace exporter, or
OpenTelemetry dependency. Diagnostic work is deliberately confined to the
development benchmark and uses deterministic fake Ecobee data.

## Local profiles

```bash
npm run benchmark

PERF_PROFILE_LABEL=development npm run profile
npm run profile:analyze -- development

npm run profile:trace
npm run profile:analyze -- runtime-trace
```

The commands capture:

- request throughput and latency percentiles;
- process CPU and post-GC heap deltas;
- event-loop utilization and delay;
- sampled V8 CPU and allocation profiles;
- Node, V8, and async-hooks trace events; and
- a standalone SVG CPU flamegraph.

Artifacts are written under the gitignored `.artifacts/performance/`
directory. CPU and allocation profiles can also be opened directly in Chrome
DevTools.

## Data boundary

The harness injects its own fake API client and fetch transport. It does not
load the deployment credential provider, contact Ecobee, invoke mutations, or
contain production tokens. No redaction is performed because credential data
never enters the benchmark or an MCP result.

Node trace events and inspector profiles substantially perturb timing. Use
`npm run benchmark` without a profiler for latency comparisons.
