import type { Server as HttpServer } from "node:http";
import { once } from "node:events";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import type { EcobeeApiClient } from "../src/ecobee/api.js";
import type { EcobeeAuth } from "../src/ecobee/auth.js";

const originalTracingEnabled = process.env.ECOBEE_TRACING_ENABLED;

afterEach(() => {
  if (originalTracingEnabled === undefined) {
    delete process.env.ECOBEE_TRACING_ENABLED;
  } else {
    process.env.ECOBEE_TRACING_ENABLED = originalTracingEnabled;
  }
});

describe("OpenTelemetry instrumentation", () => {
  it("emits secret-safe MCP request, server, and tool spans", async () => {
    process.env.ECOBEE_TRACING_ENABLED = "1";
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const [{ createHttpService }, { EcobeeCache }, { EcobeeApiClient }] =
      await Promise.all([
        import("../src/http.js"),
        import("../src/ecobee/cache.js"),
        import("../src/ecobee/api.js"),
      ]);
    const secret = "access_token=trace-secret";
    const api = {
      withRequestSignal: async <T>(
        _signal: AbortSignal,
        operation: () => Promise<T>,
      ) => operation(),
      getThermostats: async () => {
        throw new Error(secret);
      },
    } as unknown as EcobeeApiClient;
    const service = createHttpService({ api, cache: new EcobeeCache() });
    const listener = service.app.listen(0, "127.0.0.1");

    try {
      await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port.");
      }
      const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
      const client = new Client(
        { name: "trace-test", version: "1.0.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        },
      );
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      await client.listTools();
      const result = await client.callTool({
        name: "get_thermostat_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      await client.close();

      const tracedApi = new EcobeeApiClient(
        {
          getAccessToken: async () => "not-exported",
        } as EcobeeAuth,
        {
          baseUrl: "https://fixture.invalid",
          fetch: async () =>
            new Response(
              JSON.stringify({ thermostatList: [], status: { code: 0 } }),
              { status: 200 },
            ),
        },
      );
      await tracedApi.getThermostats({
        selectionType: "registered",
        selectionMatch: "",
      });

      const spans = exporter.getFinishedSpans();
      expect(spans.some((span) => span.name === "mcp.request")).toBe(true);
      expect(spans.some((span) => span.name === "mcp.server.create")).toBe(
        true,
      );
      const toolSpan = spans.find((span) => span.name === "mcp.tool");
      expect(toolSpan?.attributes).toMatchObject({
        "mcp.tool.name": "get_thermostat_status",
        "mcp.tool.read_only": true,
        "mcp.tool.error": true,
        "error.type": "Error",
      });
      const apiSpan = spans.find((span) => span.name === "ecobee.request");
      expect(apiSpan?.attributes).toMatchObject({
        "http.request.method": "GET",
        "http.route": "/thermostat",
        "http.response.status_code": 200,
        "ecobee.request.mutation": false,
      });
      expect(
        JSON.stringify(
          spans.map(({ name, attributes, status }) => ({
            name,
            attributes,
            status,
          })),
        ),
      ).not.toContain(secret);
    } finally {
      await service.close();
      await closeServer(listener);
      await provider.shutdown();
    }
  });
});

function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
