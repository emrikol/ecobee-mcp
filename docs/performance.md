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

### 2.2.0 application-path cleanup

Version 2.2.0 removes the remaining non-MCP production packages and the
duplicate schema/serialization work they caused. These measurements compare
the same unprofiled loopback workload immediately before and after the change:

| Scenario                      | 2.1.1 req/s | 2.2.0 req/s | Change | 2.1.1 p50 | 2.2.0 p50 |
| ----------------------------- | ----------: | ----------: | -----: | --------: | --------: |
| Tool discovery                |       690.3 |       781.5 | +13.2% |   1.40 ms |   1.24 ms |
| Cached thermostat status      |     1,770.7 |     2,019.9 | +14.1% |   0.50 ms |   0.43 ms |
| Cached status, concurrent     |     2,225.6 |     2,687.9 | +20.8% |   6.87 ms |   5.64 ms |
| Full-day unsummarized runtime |       210.0 |       291.5 | +38.8% |   4.75 ms |   3.44 ms |
| 512 KiB chunked transport     |       983.1 |     1,034.7 |  +5.3% |   0.98 ms |   0.95 ms |

The production dependency list now contains only the official MCP server and
Node adapter packages. The transport uses `node:http`; selective gzip uses
`node:zlib`; and direct bounded JSON Schemas use the SDK's own validator. The
canonical discovery schemas and their pinned digest are unchanged.

The final sampled profile fell from 3.116 to 2.631 CPU seconds, a 15.6%
reduction. The prior Zod output parse accounted for 154.9 sampled milliseconds
and 365.4 MiB of sampled allocation; that frame is absent from application
code in the final profile. Avoiding `Object.entries()` inside the exact byte
counter also removed 117 MiB of transient sampled allocation from an interim
implementation.

## Production memory baseline

The deployed service is a bare-metal systemd process on an 8 GiB Raspberry Pi
running Node 20. After normal discovery and read traffic, it holds approximately
98–100 MiB RSS, including roughly 58–60 MiB of anonymous memory. RSS also
counts clean file-backed pages that the kernel can reclaim, so it is not the
same as memory uniquely unavailable to other processes.

At measurement time, Ecobee MCP was the Pi's only Node process. The host had
approximately 6.1 GiB available, no swap use, and no observed memory pressure.
The service therefore has no current operational memory constraint.

Controlled startup probes showed that V8's `--optimize-for-size` and a 1 MiB
young-generation semi-space could lower RSS, but they slowed representative
workloads by 9–76% and 19–69%, respectively. A 64 MiB old-generation limit
provided no material savings. No V8 memory flag is deployed because each
useful RSS reduction cost substantially more CPU and latency than it saved.

The official MCP SDK, its schema registration, and the Node/V8 runtime account
for most of the process baseline. The application-owned duplicate validation,
serialization, and telemetry costs found in the profiles have already been
removed. A Rust rewrite is therefore deferred until memory becomes an actual
constraint; [the future-work plan](../TODO.md) defines the triggers and parity
requirements.

## Wire size

Large JSON responses use HTTP gzip negotiation implemented with Node's built-in
zlib module. Small tool reads and event streams bypass compression.

| Response                   | Decoded bytes | Wire bytes | Reduction | Encoding |
| -------------------------- | ------------: | ---------: | --------: | -------- |
| `tools/list`               |        47,866 |      5,355 |     88.8% | gzip     |
| Cached thermostat status   |           560 |        560 |         0 | identity |
| Full-day runtime intervals |       119,915 |     11,617 |     90.3% | gzip     |

The runtime result previously serialized the same large object into both text
and `structuredContent`, producing about 325 KiB before the outer response-size
check. Structured results now retain the validated `structuredContent` and use
a short text pointer. This also reduced the representative status response by
25.6%. The complete serialized tool result remains bounded to 256 KiB.

## Profile findings and fixes

The original baseline flamegraph attributed about 30% of sampled self CPU to
repeated Zod JSON Schema conversion. Version 2.1 cached that conversion.
Version 2.2 removes the second schema implementation entirely: immutable JSON
Schemas are compiled once through the official SDK, SDK-validated inputs are
not validated again, and locally validated outputs are not immediately
revalidated by the SDK.

The 2.1.1 follow-up profile identified three remaining application-owned
costs: Zod output parsing and cloning, a full `JSON.stringify` used only to
measure response size, and per-row CSV `split()` arrays in runtime reports.
Version 2.2 removes all three. The response limiter now walks JSON-safe values
without allocating a second serialized payload, and a deterministic generated
domain test compares its byte count against `JSON.stringify`. Runtime rows are
materialized directly into the required output objects.

The remaining large allocations in the runtime benchmark are the interval
objects and strings that constitute the requested result itself. SDK schema
validation, per-request server registration, JSON-RPC serialization, HTTP
buffers, and gzip are also visible in profiles; they are required protocol or
output work rather than removable duplicate application work. Large likely
responses use gzip level 4; small, latency-sensitive reads avoid compression
setup.

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
