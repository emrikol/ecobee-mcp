import { timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
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
import { createMcpServer } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;

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

  app.all("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (
      options.authToken &&
      !matchesBearerToken(req.headers.authorization, options.authToken)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    void handleMcp(req, res, req.body).catch(next);
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
