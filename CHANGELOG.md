# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
