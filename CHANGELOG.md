# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.3.1] - 2026-08-17

### Changed

- Updated the pinned MCP SDK performance fork to commit
  `b7608a8ebbd19c33089f2b616b80df7592c84fba` and switched every production
  server import to its narrow `/runtime` entry.
- The Node adapter no longer pulls in the package root. AJV and tool validators
  now stay unloaded through `server/discover` and `tools/list`; the first tool
  call loads AJV and compiles only that tool's input and output validators.
- Added opt-in low-memory operation with `MCP_PERFORMANCE_CACHES=0`. Performance
  caches remain enabled by default because disabling them materially reduces
  read throughput.

### Performance

- Across seven fresh scale-2 runs, median post-warmup harness memory fell by
  8.2 MiB RSS and 6.4 MiB used heap versus 2.3.0. Post-workload memory fell by
  29.6 MiB RSS and 5.0 MiB used heap.
- With caches disabled, the scale-1 workload used 71.6 MiB less post-workload
  RSS than cache-on, but representative read throughput fell by 42–86%.
- The isolated Node adapter import fell from 36.0 to 25.6 MiB RSS and from
  13.43 to 6.87 MiB used heap.
- On the deployed Pi, the service settles near 78.6 MiB RSS and 37.0 MiB
  anonymous after discovery and a read, down from approximately 110 MiB RSS
  and 70 MiB anonymous on 2.3.0.

### Tests

- Added application coverage proving the complete inventory and a deterministic
  read remain identical with SDK performance caches disabled.
- Re-ran the SDK's 588 core, server, and Node tests plus its deterministic
  three-mode 20,000-request profiler.

## [2.3.0] - 2026-08-17

### Changed

- Replaced the npm-published MCP server, Node adapter, and core runtime with
  pinned packages built from the performance fork at commit
  `346fdcc5e6be5c2b2a92b9043dc1d7ec41d570f9`.
- Committed the three pinned SDK tarballs with source, checksum, license, and
  rebuild documentation. Production deployment now syncs those artifacts
  before its locked npm install.
- Kept the official `@modelcontextprotocol/client@2.0.0` as the independent
  development and protocol-verification client.

### Performance

- Across seven fresh deterministic runs, median throughput improved by 11.0%
  for discovery, 39.3% for sequential cached status, 54.3% for concurrent
  cached status, and 5.2% for full-day runtime intervals. The SDK-independent
  512 KiB Ecobee transport probe was unchanged.
- The sampled full workload used 23.9% less CPU. A focused 20,000-request SDK
  profile reduced median hot wall time by 69.3%, hot CPU time by 68.6%,
  retained heap by 96.8%, and retained RSS by 55.8%.
- The speedup trades approximately 10 MiB of additional post-warmup application
  RSS. The deployed Pi settles near 110 MiB RSS with about 70 MiB anonymous and
  retains over 6 GiB of available system memory.

### Tests

- Added pinned-package checksum and file-dependency coverage while retaining
  the complete modern protocol, schema, safety, OAuth, and cancellation suite.
- Added deterministic post-GC process-memory snapshots after harness warmup and
  after the complete workload.

## [2.2.0] - 2026-08-17

### Changed

- Reduced direct production dependencies to the official `@modelcontextprotocol/server` and `@modelcontextprotocol/node` packages only. Node's built-in HTTP and zlib modules now provide the small required transport and selective-gzip surfaces.
- Replaced Zod-authored runtime schemas with direct, bounded JSON Schemas validated by the MCP SDK. The complete 24-tool discovery document and pinned schema digest remain byte-for-byte unchanged.
- Replaced duplicate structured-result serialization with an exact non-allocating JSON byte counter and removed dead non-string summary construction.
- Reworked runtime-report CSV parsing to avoid a temporary split array for every interval row.

### Performance

- Improved the same deterministic unprofiled workload by 13.2% for discovery, 14.1% for sequential cached status, 20.8% for concurrent cached status, and 38.8% for full-day runtime intervals compared with 2.1.1.

### Tests

- Added a deterministic 1,000-case JSON byte-count oracle and a production dependency-boundary test while retaining the full protocol, schema, safety, cancellation, OAuth, rate-limit, deadline, and ambiguous-delivery suite.

## [2.1.1] - 2026-08-17

### Changed

- Removed recursive result redaction; credential data remains isolated from MCP result construction, fixed public errors, health output, and development fixtures by design.
- Removed production OpenTelemetry instrumentation and dependencies. CPU, allocation, trace-event, event-loop, and flamegraph diagnostics remain development-only and disabled outside explicit benchmark commands.
- Stopped duplicating structured results into text content; non-string/default text now points clients to the complete validated `structuredContent`.
- Production builds now clean `dist/` before compilation so removed modules cannot survive as stale deployment artifacts.

## [2.1.0] - 2026-08-17

### Added

- Added opt-in OpenTelemetry spans for MCP requests, server construction, tool execution, Ecobee requests, queue time, retries, and cache outcomes.
- Added a deterministic fake-Ecobee performance harness with latency percentiles, throughput, CPU, heap, event-loop, wire-size, CPU-profile, allocation-profile, trace-event, and SVG flamegraph output.
- Added performance and observability operating guides.

### Changed

- Cached immutable JSON Schema conversion and strict schemas shared by per-request MCP servers, removing the primary CPU and allocation hotspot.
- Removed redundant input/output validation passes while retaining local validation, exact discovery schemas, strict inputs, redaction, and SDK validation for externally supplied results.
- Made secret-free structured redaction copy-on-write and added a cheap fast path for ordinary text.
- Reduced structured-result serialization and resource formatting overhead.
- Added selective gzip compression for discovery and potentially large read results while leaving small reads and event streams uncompressed.
- Made the default tracing path lazy so it does not load or instantiate the trace SDK unless tracing is enabled.

### Tests

- Added trace topology and trace-redaction tests with an in-memory OpenTelemetry exporter.
- Added selective-compression coverage and kept the official SDK v2 protocol, schema-inventory, read/write safety, cancellation, deadline, rate-limit, refresh, and ambiguous-delivery suites intact.

## [2.0.0] - 2026-08-17

### Changed

- Replaced the monolithic v1 SDK with the official split v2 server and Node packages.
- Moved the HTTP endpoint to the forward-only MCP `2026-07-28` protocol using `server/discover`; legacy initialization is rejected.
- Added explicit, bounded input and output schemas and read/write annotations for all 24 built-in tools.
- Added structured mutation results with target, requested change, reconciliation state, and verification status.
- Propagated stream-close cancellation and bounded Ecobee request deadlines, rate-limit handling, and response sizes.
- Hardened OAuth, API, plugin, health, and tool error paths against credential disclosure.

### Tests

- Added official SDK v2 client coverage for discovery, exact tool inventory and schemas, resources, authentication, malformed input, cancellation, and modern-only negotiation.
- Added deterministic fake-transport coverage for deadlines, rate limits, token refresh, redaction, response limits, and ambiguous mutation delivery.

## [1.0.0] - 2025-02-09

### Added

- MCP server with Streamable HTTP transport on `/mcp`
- 24 tools covering the full Ecobee thermostat API (14 read, 10 write)
- 3 resources: thermostat status, remote sensors, weather forecast
- Bearer token authentication
- Two auth modes: `readonly` (external token management) and `full` (managed OAuth refresh)
- Response caching with configurable TTL
- Plugin system for custom credential providers and extra tools
- Deployment scripts for Raspberry Pi via SSH + systemd
- Health check endpoint at `/health`
