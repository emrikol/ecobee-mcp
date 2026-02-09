# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
