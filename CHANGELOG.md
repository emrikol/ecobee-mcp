# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
