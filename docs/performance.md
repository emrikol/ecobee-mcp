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

### 2.3.1 lazy SDK runtime and cache tradeoff

Version 2.3.1 updates the performance fork to commit
`b7608a8ebbd19c33089f2b616b80df7592c84fba` and uses
`@modelcontextprotocol/server/runtime` throughout production. The Node adapter
now uses the same narrow entry. AJV, the optional public protocol-schema
catalog, and the unused 2025 wire era remain unloaded through
`server/discover` and `tools/list`. The first `tools/call` dynamically loads AJV
and compiles only the selected tool's input and output validators.

The SDK exposes a per-server `performanceCaches` option. Ecobee keeps it enabled
by default and maps `MCP_PERFORMANCE_CACHES=0` to the SDK's low-memory mode.
Across seven fresh scale-1 processes, cache-off reduced post-workload RSS by
71.6 MiB but changed live heap by less than 1 MiB after the first read because
Node retains the dynamically imported AJV module. Recompiling validators
reduced representative read throughput by 42–86%:

| Scenario                      | Cache-on req/s | Cache-off req/s | Change |
| ----------------------------- | -------------: | --------------: | -----: |
| Tool discovery                |          847.9 |           833.0 |  -1.8% |
| Cached thermostat status      |        2,728.2 |           418.2 | -84.7% |
| Cached status, concurrent     |        3,977.5 |           551.4 | -86.1% |
| Full-day unsummarized runtime |          342.4 |           198.9 | -41.9% |
| 512 KiB chunked transport     |          965.4 |           977.4 |  +1.2% |

The transport control remains effectively unchanged. Cache-off is therefore
available for a hard memory ceiling or very low call volume, not recommended
as the general deployment setting.

The scale-2 cache-on harness uses less memory than 2.3.0 on the same Node
22.19.0 macOS arm64 host:

| Post-GC stage  | 2.3.0 RSS | 2.3.1 RSS |    Change | 2.3.0 heap | 2.3.1 heap |   Change |
| -------------- | --------: | --------: | --------: | ---------: | ---------: | -------: |
| After warmup   | 215.9 MiB | 207.7 MiB |  -8.2 MiB |   50.1 MiB |   43.7 MiB | -6.4 MiB |
| After workload | 407.6 MiB | 378.1 MiB | -29.6 MiB |   52.7 MiB |   47.7 MiB | -5.0 MiB |

An eleven-process import isolation measured the Node adapter at 25.6 MiB RSS
and 6.87 MiB heap, down from 36.0 MiB RSS and 13.43 MiB heap. The SDK's own
seven-run, 128-tool profiler confirmed zero AJV evaluations and validator
compilations through `tools/list`; the first tool call evaluated AJV once and
compiled exactly two validators. Its 20,000-call cache-off case compiled
40,002 validators, explaining the intentional speed-versus-RSS tradeoff.

### 2.3.0 SDK hot-path fork

Version 2.3.0 uses the performance fork of the official TypeScript SDK at
commit `346fdcc5e6be5c2b2a92b9043dc1d7ec41d570f9`. These results are medians of
seven fresh, unprofiled processes per candidate on Node.js 22.19.0, macOS
arm64, with `PERF_REQUEST_SCALE=2`:

| Scenario                      | Official req/s | Fork req/s | Change | Official p50 | Fork p50 |
| ----------------------------- | -------------: | ---------: | -----: | -----------: | -------: |
| Tool discovery                |          789.3 |      876.4 | +11.0% |      1.21 ms |  1.11 ms |
| Cached thermostat status      |        2,229.1 |    3,104.6 | +39.3% |      0.39 ms |  0.27 ms |
| Cached status, concurrent     |        3,055.4 |    4,715.0 | +54.3% |      5.08 ms |  3.00 ms |
| Full-day unsummarized runtime |          325.2 |      342.0 |  +5.2% |      3.08 ms |  2.92 ms |
| 512 KiB chunked transport     |          982.9 |      980.0 |  -0.3% |      0.98 ms |  0.98 ms |

The unchanged Ecobee transport probe is outside the SDK request path and acts
as a control. Wire sizes and all canonical discovery schemas were also
unchanged.

The identical sampled workload fell from 5.156 to 3.922 CPU seconds, a 23.9%
reduction. Schema-conversion and header-scan frames that previously consumed
about 205 sampled CPU milliseconds and 167 MiB of sampled allocation no longer
appear as per-request costs.

The fork's focused server profile ran 20,000 modern `tools/call` requests in
each of seven fresh processes. Median hot wall time fell from 109.74 to 33.67
microseconds per request, and hot CPU time fell from 177.78 to 55.86
microseconds per request. Post-GC retained heap fell from 52.1 to 1.7 MiB and
retained RSS from 283.7 to 125.3 MiB for that synthetic workload.

Cold root-package import memory was effectively unchanged. Ecobee uses the
official Node adapter, which imports the server package root; switching only
Ecobee's direct imports to the fork's narrower `/runtime` entry would therefore
load both entries and would not reduce the deployed baseline.

The complete Ecobee harness does retain more baseline memory with the fork.
Across seven fresh post-GC runs, median RSS after discovery and one cached read
increased from 205.7 to 215.9 MiB; after the scale-2 workload it increased from
390.8 to 407.6 MiB. Median used heap increased by 6.3 MiB after warmup and 6.7
MiB after the workload. Those absolute values include the TypeScript loader,
official client, fixtures, and benchmark machinery and are not production
footprints, but the paired delta is meaningful.

## Production memory baseline

The deployed service is a bare-metal systemd process on an 8 GiB Raspberry Pi
running Node 20. Before 2.3.0 it held approximately 98–100 MiB RSS, including
roughly 58–60 MiB of anonymous memory. After the performance-fork deployment,
the same post-discovery sample settled near 110 MiB RSS with about 70 MiB
anonymous. RSS also counts clean file-backed pages that the kernel can reclaim,
so it is not the same as memory uniquely unavailable to other processes.

At measurement time, Ecobee MCP was the Pi's only Node process. The host had
approximately 6.1 GiB available, no swap use, and no observed memory pressure.
The service therefore has no current operational memory constraint.

Controlled startup probes showed that V8's `--optimize-for-size` and a 1 MiB
young-generation semi-space could lower RSS, but they slowed representative
workloads by 9–76% and 19–69%, respectively. A 64 MiB old-generation limit
provided no material savings. No V8 memory flag is deployed because each
useful RSS reduction cost substantially more CPU and latency than it saved.

The MCP SDK, its schema registration, and the Node/V8 runtime account for most
of the process baseline. The application-owned duplicate validation,
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
Version 2.2 removes the second schema implementation entirely. Version 2.3.1
keeps immutable raw JSON Schemas cold through discovery, avoids revalidating
SDK-validated inputs in the application callback, and lets the SDK perform the
single structured-output validation before serialization. This preserves
local schema enforcement while allowing the SDK's cache policy to own derived
validator lifetime.

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
size, compressed wire size, and post-GC process memory after warmup and after
the complete workload.

Generated files are gitignored under `.artifacts/performance/`:

- `*-benchmark.json` — machine-readable benchmark report;
- `*.cpuprofile` — Chrome DevTools-compatible sampled CPU profile;
- `*.heapprofile` — Chrome DevTools-compatible sampled allocation profile;
- `*-analysis.json` — ranked self-CPU and allocation frames;
- `*-flamegraph.svg` — standalone interactive-tooltip CPU flamegraph; and
- `node-trace-*.json` — Node/V8/async-hooks trace events from `profile:trace`.

Run unprofiled benchmarks for latency decisions. Inspector sampling and Node
trace events intentionally perturb timing.
