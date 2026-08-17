# Performance

The performance harness exercises the production HTTP adapter, modern MCP
negotiation metadata, official SDK v2 client, tool schemas, validation,
serialization, compression, cache, and bounded Ecobee response reader. It uses
deterministic in-memory Ecobee fixtures and an injected fetch transport. It
never contacts the live Ecobee API and never invokes a mutation.

## Release results

These measurements compare the same unprofiled loopback workload before and
after the 2.1.0 changes on Node.js 22.19.0, macOS arm64. They are diagnostic
results, not portable service-level objectives; CPU, Node version, background
load, and deployment networking will change absolute values.

| Scenario                      | Requests | Concurrency | Baseline req/s | 2.1.0 req/s | Change | Baseline p50 | 2.1.0 p50 |
| ----------------------------- | -------: | ----------: | -------------: | ----------: | -----: | -----------: | --------: |
| Tool discovery                |      400 |           1 |          213.6 |       644.7 |  +202% |      4.56 ms |   1.52 ms |
| Cached thermostat status      |      600 |           1 |          330.4 |     1,586.7 |  +380% |      2.73 ms |   0.56 ms |
| Cached status, concurrent     |    1,600 |          16 |          370.5 |     2,101.5 |  +467% |     41.86 ms |   7.44 ms |
| Full-day unsummarized runtime |      120 |           1 |           86.6 |       145.9 |   +68% |     11.29 ms |   6.89 ms |

The release CPU profile sampled 3.663 seconds over the full workload, compared
with 22.812 seconds at baseline. That is an 83.9% reduction even though the
release workload also includes selective gzip and 60 additional 512 KiB
chunked-response probes. CPU-profile timings include profiler overhead and
should only be compared with other profiled runs.

The chunked Ecobee transport probe remained about 1 ms per 512 KiB response.
Changing its string accumulator to an array and final join did not improve the
measurement, so that speculative change was not retained.

### 2.1.1 production-path cleanup

Removing recursive result sanitization and all production telemetry wrappers
reduced the same sampled workload from 3.663 to 3.287 CPU seconds, a further
10.3%. The unprofiled full-day runtime scenario improved from 145.9 to 171.6
requests per second, with median latency falling from 6.89 to 5.79 ms. The
development profiler and trace-event commands remain available but no
diagnostic hook executes in production.

Structured-result self CPU then fell from 76.6 to 56.3 sampled milliseconds,
and its sampled allocation fell from 63.2 to 33.3 MiB, after eliminating the
discarded duplicate text serialization. Total-profile timing for that run was
not used because concurrent system load and garbage collection made it noisy.

## Wire size

Large JSON responses use normal HTTP content negotiation for Brotli, gzip, or
deflate. Small tool reads and event streams bypass compression. The table below
records the harness's gzip path.

| Response                   | Decoded bytes | Wire bytes | Reduction | Encoding |
| -------------------------- | ------------: | ---------: | --------: | -------- |
| `tools/list`               |        47,866 |      5,358 |     88.8% | gzip     |
| Cached thermostat status   |           560 |        560 |         0 | identity |
| Full-day runtime intervals |       119,915 |     11,617 |     90.3% | gzip     |

The runtime result previously serialized the same large object into both text
and `structuredContent`, producing about 325 KiB before the outer response-size
check. Structured results now retain the validated `structuredContent` and use
a short text pointer. This also reduced the representative status response by
25.6%. The complete serialized tool result remains bounded to 256 KiB.

## Profile findings and fixes

The baseline flamegraph attributed about 30% of sampled self CPU to repeated
Zod JSON Schema conversion. The v2 HTTP adapter intentionally creates a fresh
MCP server for each request, but the 24 built-in tool schema objects are
immutable and shared. Version 2.1.0 therefore caches:

- strict input-schema wrappers;
- Standard Schema JSON conversion by schema, direction, and target;
- the fact that an object has already passed SDK input validation; and
- the fact that an output object has already passed local validation.

External or replacement results still take the SDK validation path. Discovery
schemas and their digest are unchanged.

The remaining top application costs are structured-result validation,
serialization, and the large runtime fixture. Resources use compact JSON.
Large likely responses use a balanced compression level; small,
latency-sensitive reads avoid compression setup.

## Reproduce

```bash
npm run benchmark

PERF_PROFILE_LABEL=release npm run profile
npm run profile:analyze -- release

npm run profile:trace
npm run profile:analyze -- runtime-trace
```

Set `PERF_REQUEST_SCALE` from 1 through 20 to lengthen all scenarios. The
benchmark emits throughput, min/p50/p95/p99/max/mean latency, CPU time,
event-loop utilization, event-loop delay, post-GC heap delta, decoded response
size, and compressed wire size.

Generated files are gitignored under `.artifacts/performance/`:

- `*-benchmark.json` — machine-readable benchmark report;
- `*.cpuprofile` — Chrome DevTools-compatible sampled CPU profile;
- `*.heapprofile` — Chrome DevTools-compatible sampled allocation profile;
- `*-analysis.json` — ranked self-CPU and allocation frames;
- `*-flamegraph.svg` — standalone interactive-tooltip CPU flamegraph; and
- `node-trace-*.json` — Node/V8/async-hooks trace events from `profile:trace`.

Run unprofiled benchmarks for latency decisions. Inspector sampling and Node
trace events intentionally perturb timing.
