import { timingSafeEqual } from "node:crypto";
import { SpanKind } from "@opentelemetry/api";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import compression from "compression";
import express from "express";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import { MCP_PROTOCOL_VERSION, SERVICE_VERSION } from "./constants.js";
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
import {
  extractMcpTraceContext,
  isTracingEnabled,
  mcpMethod,
  traceOperation,
} from "./observability.js";
import { createMcpServer } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const COMPRESSIBLE_TOOLS = new Set([
  "get_alerts",
  "get_demand_response",
  "get_extended_runtime",
  "get_runtime_report",
  "get_schedule",
  "get_sensors",
  "get_weather",
  "list_vacations",
]);

export interface HttpServiceOptions {
  api: EcobeeApiClient;
  cache: EcobeeCache;
  plugins?: EcobeePlugin[];
  authToken?: string;
}

export interface EcobeeHttpService {
  app: express.Express;
  close: () => Promise<void>;
}

export function createHttpService(
  options: HttpServiceOptions,
): EcobeeHttpService {
  const plugins = options.plugins ?? [];
  const mcp = createMcpHandler(
    () => createMcpServer(options.api, options.cache, plugins),
    {
      legacy: "reject",
      responseMode: "auto",
      onerror: () => console.error("[mcp] Request rejected"),
    },
  );
  const handleMcp = toNodeHandler(mcp, {
    onerror: () => console.error("[mcp] HTTP adapter failed"),
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: MAX_MCP_REQUEST_BYTES,
      strict: true,
      type: ["application/json", "application/*+json"],
    }),
  );
  const compressLargeMcpResponse = compression({
    level: 4,
    threshold: 1_024,
    filter: (req, res) => {
      const contentType = res.getHeader("content-type");
      if (
        typeof contentType === "string" &&
        contentType.startsWith("text/event-stream")
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  });
  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (shouldCompressMcpResponse(req.body)) {
      compressLargeMcpResponse(req, res, next);
      return;
    }
    next();
  });

  app.all("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const method = mcpMethod(req.body);
    void traceOperation(
      "mcp.request",
      {
        kind: SpanKind.SERVER,
        parent: isTracingEnabled()
          ? extractMcpTraceContext(req.body)
          : undefined,
        attributes: {
          "http.request.method": req.method,
          "http.route": "/mcp",
          "mcp.method": method,
          "mcp.protocol.version": MCP_PROTOCOL_VERSION,
        },
      },
      async (span) => {
        if (
          options.authToken &&
          !matchesBearerToken(req.headers.authorization, options.authToken)
        ) {
          span.setAttribute("mcp.authenticated", false);
          span.setAttribute("http.response.status_code", 401);
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        span.setAttribute("mcp.authenticated", Boolean(options.authToken));
        await handleMcp(req, res, req.body);
        span.setAttribute("http.response.status_code", res.statusCode);
      },
    ).catch(next);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      serviceVersion: SERVICE_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      authentication: options.authToken ? "bearer-required" : "disabled",
    });
  });

  const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status === 413 ? "Request body too large" : "Malformed request",
    });
  };
  app.use(jsonErrorHandler);

  return { app, close: mcp.close };
}

function shouldCompressMcpResponse(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method === "tools/list" || request.method === "resources/read") {
    return true;
  }
  if (
    request.method !== "tools/call" ||
    typeof request.params !== "object" ||
    request.params === null
  ) {
    return false;
  }
  const name = (request.params as { name?: unknown }).name;
  return typeof name === "string" && COMPRESSIBLE_TOOLS.has(name);
}

function matchesBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorizationHeader.slice(7));
  const expected = Buffer.from(expectedToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
