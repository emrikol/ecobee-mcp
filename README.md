# ecobee-mcp

An MCP server for controlling [Ecobee](https://www.ecobee.com/) thermostats through any MCP-compatible client (Claude Desktop, Claude Code, etc.).

Built with TypeScript, Express 5, and the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Features

**24 tools** covering the full Ecobee API:

| Read | Write |
|---|---|
| List thermostats | Set temperature |
| Thermostat status | Set HVAC mode |
| Remote sensors | Set hold (comfort profile) |
| Weather forecast | Resume schedule |
| Schedule | Set vacation |
| Vacations | Acknowledge alert |
| Alerts | Send thermostat message |
| Runtime report | Update comfort profile |
| Extended runtime | Update house details |
| Demand response | Manage thermostat groups |
| Utility info | |
| Technician info | |
| House details | |
| Thermostat groups | |

**3 resources** for quick context:
- `ecobee://thermostat/status` — current thermostat state
- `ecobee://thermostat/sensors` — remote sensor readings
- `ecobee://thermostat/weather` — weather forecast data

**Other:**
- Bearer token authentication
- Two auth modes: `readonly` (another app manages tokens) or `full` (manages its own OAuth refresh)
- Plugin system for custom credential providers and extra tools
- Response caching with configurable TTL

## Ecobee API Access

**Ecobee no longer issues new API keys.** The [developer portal](https://www.ecobee.com/developers/) is effectively closed — new registrations are not accepted.

If you have a **grandfathered API key** (registered before the portal closed), this server works directly with your credentials. If not, you have a couple of options:

1. **Piggyback on an existing integration.** If you already run an app that authenticates with the Ecobee API (e.g., a smart home platform), you can point ecobee-mcp at that app's credentials in `readonly` mode. ecobee-mcp will never refresh tokens itself — it just reads them and re-reads on 401 in case the other app has refreshed. See [Auth Modes](#auth-modes) below.

2. **Write a credential provider plugin.** If the existing app stores tokens somewhere other than a plain JSON file (e.g., a database), write a plugin that implements the `CredentialProvider` interface to read from that source. See [Plugins](#plugins) below.

This project was built to work alongside another authenticated Ecobee app that manages the full OAuth lifecycle. ecobee-mcp acts as a read-only parasite on those credentials.

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

Point your MCP client at the server. For example, in Claude Desktop:

```json
{
  "mcpServers": {
    "ecobee": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-auth-token-here"
      }
    }
  }
}
```

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
  registerTools?: (server: McpServer, api: EcobeeApiClient, cache: EcobeeCache) => void;
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
npm test            # Run tests
npm run test:watch  # Watch mode
npm run lint        # Lint
npm run lint:fix    # Lint + auto-fix
```

## Support Policy

This project is published **as-is** under the [GPL-3.0 license](LICENSE).

- **No support** is provided — no bug fixes, feature requests, or troubleshooting.
- **Issues are disabled.** The issue tracker is not monitored.
- **Pull requests are collaborator-only.** Non-collaborator PRs are automatically closed.
- You are welcome to **fork** this project and adapt it for your own use under the GPL.

If you redistribute a modified version, please use a different project name and branding to avoid confusion.

## License

[GPL-3.0](LICENSE)
