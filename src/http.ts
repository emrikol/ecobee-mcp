import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createGzip, type Gzip } from "node:zlib";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type McpHttpHandler,
  type ServerEventBus,
} from "@modelcontextprotocol/server/runtime";
import { MCP_PROTOCOL_VERSION, SERVICE_VERSION } from "./constants.js";
import {
  ToolCatalogStore,
  type CatalogReloadResult,
  type ToolCatalogInfo,
  type ToolCatalogLoader,
} from "./catalog.js";
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
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
  catalogLoader?: ToolCatalogLoader;
  eventBus?: ServerEventBus;
  authToken?: string;
  performanceCaches?: boolean;
}

export interface NodeHttpApplication {
  (request: IncomingMessage, response: ServerResponse): void;
  listen(
    port: number,
    hostname?: string,
    listeningListener?: () => void,
  ): Server;
}

export interface EcobeeHttpService {
  app: NodeHttpApplication;
  close: () => Promise<void>;
  catalog: () => ToolCatalogInfo;
  reloadCatalog: () => Promise<CatalogReloadResult>;
}

export async function createHttpService(
  options: HttpServiceOptions,
): Promise<EcobeeHttpService> {
  const plugins = options.plugins ?? [];
  let publishToolsChanged = (): void => undefined;
  const catalog = await ToolCatalogStore.create(
    options.api,
    options.cache,
    plugins,
    options.catalogLoader,
    () => publishToolsChanged(),
  );
  const toolsListChanged = options.catalogLoader !== undefined;
  const requestCatalogs = toolsListChanged
    ? new WeakMap<Request, ReturnType<typeof catalog.capture>>()
    : undefined;
  const mcp = createMcpHandler(
    ({ requestInfo }) => {
      const snapshot =
        (requestInfo && requestCatalogs?.get(requestInfo)) ?? catalog.capture();
      return createMcpServer(
        options.api,
        options.cache,
        snapshot,
        plugins,
        options.performanceCaches,
        toolsListChanged,
      );
    },
    {
      legacy: "reject",
      responseMode: "auto",
      ...(options.eventBus ? { bus: options.eventBus } : {}),
    },
  );
  publishToolsChanged = () => mcp.notify.toolsChanged();
  const snapshotBoundMcp: McpHttpHandler | undefined = requestCatalogs
    ? {
        ...mcp,
        fetch: async (request, requestOptions) => {
          requestCatalogs.set(request, catalog.capture());
          try {
            return await mcp.fetch(request, requestOptions);
          } finally {
            requestCatalogs.delete(request);
          }
        },
      }
    : undefined;
  const handleMcp = toNodeHandler(snapshotBoundMcp ?? mcp);

  const requestListener = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    void routeRequest(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Malformed request" });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };

  async function routeRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        status: "ok",
        serviceVersion: SERVICE_VERSION,
        protocolVersion: MCP_PROTOCOL_VERSION,
        authentication: options.authToken ? "bearer-required" : "disabled",
      });
      return;
    }

    if (pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (
      options.authToken &&
      !matchesBearerToken(request.headers.authorization, options.authToken)
    ) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error instanceof BodyTooLargeError ? 413 : 400, {
          error:
            error instanceof BodyTooLargeError
              ? "Request body too large"
              : "Malformed request",
        });
        return;
      }
    }

    const targetResponse =
      shouldCompressMcpResponse(body) && acceptsGzip(request.headers)
        ? new GzipResponse(response)
        : response;
    await handleMcp(request, targetResponse, body);
  }

  const app = Object.assign(requestListener, {
    listen(
      port: number,
      hostname?: string,
      listeningListener?: () => void,
    ): Server {
      return createServer(requestListener).listen(
        port,
        hostname,
        listeningListener,
      );
    },
  });

  return {
    app,
    close: mcp.close,
    catalog: () => catalog.info(),
    reloadCatalog: () => catalog.reload(),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(request.headers["content-type"])) {
    throw new Error("Unsupported content type.");
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_MCP_REQUEST_BYTES
  ) {
    request.resume();
    throw new BodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("Empty JSON body.");

  const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString());
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON body must be an object or array.");
  }
  return parsed;
}

class BodyTooLargeError extends Error {}

/** Minimal response facade that adds gzip to bounded, non-streaming MCP reads.
 * The SDK still owns response creation and stream-close cancellation. */
class GzipResponse {
  private readonly gzip: Gzip;

  constructor(private readonly response: ServerResponse) {
    this.gzip = createGzip({ level: 4 });
    this.gzip.pipe(response);
    this.gzip.on("error", () => response.destroy());
  }

  get destroyed(): boolean {
    return this.response.destroyed;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "drain") {
      this.gzip.on(event, listener);
    } else {
      this.response.on(event, listener);
    }
    return this;
  }

  writeHead(status: number, headers: Record<string, string>): this {
    const compressedHeaders: OutgoingHttpHeaders = { ...headers };
    delete compressedHeaders["content-length"];
    compressedHeaders["content-encoding"] = "gzip";
    const vary = compressedHeaders.vary;
    compressedHeaders.vary = vary
      ? `${String(vary)}, Accept-Encoding`
      : "Accept-Encoding";
    this.response.writeHead(status, compressedHeaders);
    return this;
  }

  write(chunk: Uint8Array): boolean {
    return this.gzip.write(chunk);
  }

  end(): this {
    this.gzip.end();
    return this;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function acceptsGzip(headers: IncomingHttpHeaders): boolean {
  const value = headers["accept-encoding"];
  if (!value) return false;
  const encodings = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .map((part) => {
      const [name, ...parameters] = part.split(";").map((item) => item.trim());
      const quality = parameters
        .find((parameter) => parameter.startsWith("q="))
        ?.slice(2);
      return { name, quality: quality === undefined ? 1 : Number(quality) };
    });
  const gzip = encodings.find(({ name }) => name === "gzip");
  if (gzip) return gzip.quality > 0;
  return (encodings.find(({ name }) => name === "*")?.quality ?? 0) > 0;
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
