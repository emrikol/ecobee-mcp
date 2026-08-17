# ecobee-mcp

An MCP server for controlling [Ecobee](https://www.ecobee.com/) thermostats through clients that support MCP `2026-07-28`.

Built with TypeScript, Node's built-in HTTP and compression modules, and the official split v2 packages `@modelcontextprotocol/server` and `@modelcontextprotocol/node`. Those two MCP packages are the only direct production dependencies.

Version 2 is forward-only: it uses `server/discover`, advertises only MCP `2026-07-28`, and rejects the legacy `initialize` handshake. The HTTP endpoint remains `/mcp`.

## Features

**24 tools** covering the supported Ecobee operations. Every tool has a strict,
bounded input schema, a bounded output schema, and an explicit safety annotation.

| Tool                     | Class    | Operation                          |
| ------------------------ | -------- | ---------------------------------- |
| `list_thermostats`       | Read     | List registered thermostats        |
| `get_thermostat_status`  | Read     | Read thermostat and equipment      |
| `get_sensors`            | Read     | Read remote sensors                |
| `get_weather`            | Read     | Read weather and forecast          |
| `get_schedule`           | Read     | Read climates and weekly program   |
| `list_vacations`         | Read     | List vacation events               |
| `get_alerts`             | Read     | Read active alerts                 |
| `get_runtime_report`     | Read     | Read interval runtime data         |
| `get_extended_runtime`   | Read     | Read extended runtime data         |
| `get_demand_response`    | Read     | Read demand-response events        |
| `get_utility_info`       | Read     | Read utility metadata              |
| `get_technician_info`    | Read     | Read technician metadata           |
| `get_house_details`      | Read     | Read house characteristics         |
| `list_groups`            | Read     | List thermostat groups             |
| `set_temperature`        | Mutation | Set a temperature hold             |
| `set_hvac_mode`          | Mutation | Change the HVAC mode               |
| `set_hold`               | Mutation | Set a comfort-profile hold         |
| `resume_schedule`        | Mutation | Resume the programmed schedule     |
| `set_vacation`           | Mutation | Create, update, or delete vacation |
| `acknowledge_alert`      | Mutation | Acknowledge an alert               |
| `send_message`           | Mutation | Send a thermostat message          |
| `update_comfort_profile` | Mutation | Update a comfort setting           |
| `update_house_details`   | Mutation | Update house characteristics       |
| `manage_group`           | Mutation | Create, update, or delete a group  |

Read tools advertise `readOnlyHint: true`. Mutation tools advertise
`readOnlyHint: false`, remain separate from reads, and return structured target,
requested-change, and reconciliation details. A mutation is never retried when
delivery is ambiguous.

**3 resources** for quick context:

- `ecobee://thermostat/status` — current thermostat state
- `ecobee://thermostat/sensors` — remote sensor readings
- `ecobee://thermostat/weather` — weather forecast data

**Other:**

- Bearer token authentication
- Two auth modes: `readonly` (another app manages tokens) or `full` (manages its own OAuth refresh)
- Plugin system for custom credential providers and extra tools
- 60-second read cache with in-flight request deduplication
- Bounded deadlines, concurrency, rate-limit retries, and response sizes
- Selective built-in gzip compression for large discovery and read responses
- Development-only CPU, allocation, trace-event, and flamegraph tooling

## Ecobee API Access

**Ecobee no longer issues new API keys.** The [developer portal](https://www.ecobee.com/developers/) is effectively closed — new registrations are not accepted.

If you have a **grandfathered API key** (registered before the portal closed), this server works directly with your credentials. If not, you have a couple of options:

1. **Piggyback on an existing integration.** If you already run an app that authenticates with the Ecobee API (e.g., a smart home platform), you can point ecobee-mcp at that app's credentials in `readonly` mode. ecobee-mcp will never refresh tokens itself — it just reads them and re-reads on 401 in case the other app has refreshed. See [Auth Modes](#auth-modes) below.

2. **Write a credential provider plugin.** If the existing app stores tokens somewhere other than a plain JSON file (e.g., a database), write a plugin that implements the `CredentialProvider` interface to read from that source. See [Plugins](#plugins) below.

This project can work alongside another authenticated Ecobee application that manages the full OAuth lifecycle. In `readonly` mode, ecobee-mcp only consumes credentials from the configured provider.

## Prerequisites

- Node.js 20+
- An Ecobee API key (see [Ecobee API Access](#ecobee-api-access))
- OAuth tokens for your Ecobee account (access token, refresh token)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a credentials file

Create `credentials.json` in the project root (this file is gitignored):

```json
{
  "accessToken": "your-ecobee-access-token",
  "refreshToken": "your-ecobee-refresh-token",
  "expiresAt": 1700000000000,
  "apiKey": "your-ecobee-api-key"
}
```

If another app manages your Ecobee tokens, point `CREDENTIALS_PATH` at that app's token file, or write a plugin to read from its storage.

### 3. Configure environment

Create a `.env` file (also gitignored):

```bash
PORT=3000
MCP_AUTH_TOKEN=some-random-secret-token
CREDENTIALS_PATH=./credentials.json
AUTH_MODE=readonly
# ENABLE_PLUGINS=1
```

`MCP_AUTH_TOKEN` is strongly recommended on any network-accessible deployment.

### 4. Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

The server listens on `http://0.0.0.0:3000/mcp` with a health check at `/health`.

## MCP Client Configuration

Point a modern MCP client at `/mcp`, send the configured bearer token, and explicitly enable the `2026-07-28` negotiation flow. The official TypeScript v2 client configuration is:

```typescript
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const client = new Client(
  { name: "my-client", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/mcp"),
  {
    requestInit: {
      headers: { Authorization: "Bearer your-auth-token-here" },
    },
  },
);
await client.connect(transport);
```

The v2 client still defaults to its legacy connection flow unless `versionNegotiation` is configured. A client that cannot perform `server/discover` and send the modern per-request metadata cannot consume this endpoint.

The server advertises only tools and resources. It intentionally does not advertise prompts, sampling, elicitation, logging, subscriptions, experimental extensions, or Tasks.

This is a forward-facing version boundary. There is no legacy handshake,
protocol alias, or dual-stack compatibility path.

## Auth Modes

- **`readonly`** (default) — Reads tokens from the credentials file but never refreshes them. Use this when another application manages the OAuth lifecycle. On 401, it re-reads the credentials file in case the other app has refreshed the token. This is the recommended mode when piggybacking on another integration's credentials.
- **`full`** — Manages the full OAuth token lifecycle, proactively refreshing tokens before expiry and persisting new credentials. Use this only if you have your own API key and want ecobee-mcp to handle token refresh independently.

## Plugins

Plugins are opt-in (`ENABLE_PLUGINS=1`) and loaded from the `plugins/` directory. A plugin can:

- Provide a custom credential provider (read tokens from any source)
- Register additional MCP tools and resources
- Hook into token refresh events

### Plugin interface

A plugin is a `.js` file in the `plugins/` directory that exports an `EcobeePlugin` object:

```typescript
interface EcobeePlugin {
  name: string;
  credentialProvider?: CredentialProvider;
  onTokenRefresh?: (creds: EcobeeCredentials) => Promise<void>;
  registerTools?: (
    server: McpServer,
    api: EcobeeApiClient,
    cache: EcobeeCache,
  ) => void;
  registerResources?: (server: McpServer, cache: EcobeeCache) => void;
}
```

### Example: Custom credential provider

If your existing Ecobee integration stores tokens in a SQLite database:

```javascript
// plugins/my-creds.js
import Database from "better-sqlite3";

const db = new Database("/path/to/other-app/ecobee.db");

export default {
  name: "my-credential-provider",
  credentialProvider: {
    async getCredentials() {
      const row = db.prepare("SELECT * FROM ecobee_tokens LIMIT 1").get();
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        apiKey: row.api_key,
      };
    },
    async saveCredentials() {
      // No-op — the other app manages token persistence
    },
  },
};
```

The first plugin to provide a `credentialProvider` wins. Subsequent credential providers are ignored with a warning.

## Deployment

The `scripts/` directory contains shell scripts for deploying to a Linux server (e.g., a Raspberry Pi) via SSH + systemd. These are tailored to my personal setup — see the comments in each script for what to adapt.

## Development

```bash
npm test                 # Run tests
npm run test:watch       # Watch mode
npm run build            # Type-check and compile production code
npm run typecheck:bench  # Type-check the benchmark harness
npm run lint             # Lint production, test, and benchmark code
npm run format:check     # Check formatting
npm run benchmark        # Run deterministic local benchmarks
npm run profile          # Capture CPU and allocation profiles
npm run profile:analyze  # Build analysis JSON and an SVG flamegraph
npm run profile:trace    # Capture Node trace events plus profiles
```

The benchmark uses an injected fake Ecobee transport. It never calls the live
Ecobee API and never performs a thermostat mutation. Generated profiles live in
the gitignored `.artifacts/performance/` directory.

See [Performance](docs/performance.md) for methodology, before/after results,
known costs, and profiling commands. See
[Development diagnostics](docs/observability.md) for local trace and profile
artifacts. Production contains no telemetry instrumentation or exporter.

## Support Policy

This project is published **as-is** under the [GPL-3.0 license](LICENSE).

- **No support** is provided — no bug fixes, feature requests, or troubleshooting.
- **Issues are disabled.** The issue tracker is not monitored.
- **Pull requests are collaborator-only.** Non-collaborator PRs are automatically closed.
- You are welcome to **fork** this project and adapt it for your own use under the GPL.

If you redistribute a modified version, please use a different project name and branding to avoid confusion.

## License

[GPL-3.0](LICENSE)
