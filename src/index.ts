/* v8 ignore start -- Integration test: Express HTTP server lifecycle, bearer auth
   middleware, Streamable HTTP session management, and graceful shutdown.
   Test with real HTTP requests to /mcp, /health, auth header validation,
   session creation/reuse/cleanup, and SIGINT/SIGTERM signal handling. */
import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EcobeeAuth } from "./ecobee/auth.js";
import { EcobeeApiClient } from "./ecobee/api.js";
import { EcobeeCache } from "./ecobee/cache.js";
import { FileCredentialProvider } from "./credentials/file-provider.js";
import { loadPlugins } from "./plugins/loader.js";
import { createMcpServer } from "./server.js";
import type { CredentialProvider } from "./credentials/provider.js";
import type { AuthMode } from "./ecobee/auth.js";
import type { Request, Response, NextFunction } from "express";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const AUTH_MODE = (process.env.AUTH_MODE ?? "readonly") as AuthMode;

async function main() {
  // Load plugins
  const plugins = await loadPlugins();

  // Set up credential provider (plugin can override)
  let credentialProvider: CredentialProvider = new FileCredentialProvider(
    CREDENTIALS_PATH,
  );
  const pluginWithCreds = plugins.find((p) => p.credentialProvider);
  if (pluginWithCreds) {
    credentialProvider = pluginWithCreds.credentialProvider!;
    console.log(
      `[main] Using credential provider from plugin: ${pluginWithCreds.name}`,
    );
  }

  // Set up auth, API client, cache (shared across all sessions)
  const auth = new EcobeeAuth(credentialProvider, AUTH_MODE);
  const api = new EcobeeApiClient(auth);
  const cache = new EcobeeCache();

  // Register plugin token refresh hooks
  for (const plugin of plugins) {
    if (plugin.onTokenRefresh) {
      auth.addTokenRefreshHook(plugin.onTokenRefresh);
    }
  }

  // Session tracking
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Express app
  const app = express();
  app.use(express.json());

  // Bearer token auth middleware
  if (AUTH_TOKEN) {
    app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
    console.log("[main] Bearer token auth enabled");
  } else {
    console.log("[main] WARNING: No MCP_AUTH_TOKEN set, auth disabled");
  }

  // MCP endpoint
  app.all("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Try to reuse existing transport for this session
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (transport) {
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Only create new sessions on POST (initialization)
    if (req.method !== "POST") {
      res.status(400).json({ error: "No valid session. Send POST to initialize." });
      return;
    }

    // Create new transport + server for this session
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        console.log(`[main] Session created: ${id}`);
      },
    });

    // Clean up on session close
    transport.onclose = () => {
      const id = [...transports.entries()].find(
        ([, t]) => t === transport,
      )?.[0];
      if (id) {
        transports.delete(id);
        console.log(`[main] Session closed: ${id}`);
      }
    };

    const server = createMcpServer(api, cache, plugins);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Handle DELETE for session cleanup
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", sessions: transports.size });
  });

  // Start server
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[main] Ecobee MCP server listening on 0.0.0.0:${PORT}`);
    console.log(`[main] Auth mode: ${AUTH_MODE}`);
    console.log(`[main] Plugins loaded: ${plugins.length}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[main] Shutting down...");

    // Close all sessions
    for (const [id, transport] of transports) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors during shutdown
      }
      transports.delete(id);
    }

    server.close(() => {
      console.log("[main] Server closed");
      process.exit(0);
    });

    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
