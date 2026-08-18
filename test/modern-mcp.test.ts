import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { once } from "node:events";
import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/server/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_FINGERPRINT_META_KEY,
  type ToolCatalogLoader,
  type ToolCatalogRegistrar,
} from "../src/catalog.js";
import { MCP_PROTOCOL_VERSION, SERVICE_VERSION } from "../src/constants.js";
import type { EcobeeApiClient } from "../src/ecobee/api.js";
import { EcobeeCache } from "../src/ecobee/cache.js";
import { createHttpService, type EcobeeHttpService } from "../src/http.js";
import type { EcobeePlugin } from "../src/plugins/types.js";

const READ_TOOLS = [
  "list_thermostats",
  "get_thermostat_status",
  "get_sensors",
  "get_weather",
  "get_schedule",
  "list_vacations",
  "get_alerts",
  "get_runtime_report",
  "get_extended_runtime",
  "get_demand_response",
  "get_utility_info",
  "get_technician_info",
  "get_house_details",
  "list_groups",
] as const;

const MUTATION_TOOLS = [
  "set_temperature",
  "set_hvac_mode",
  "set_hold",
  "resume_schedule",
  "set_vacation",
  "acknowledge_alert",
  "send_message",
  "update_comfort_profile",
  "update_house_details",
  "manage_group",
] as const;

const EXPECTED_TOOLS = [...READ_TOOLS, ...MUTATION_TOOLS].sort();
const AUTH_TOKEN = "test-mcp-bearer-token";

interface Harness {
  api: EcobeeApiClient;
  endpoint: URL;
  httpServer: HttpServer;
  service: EcobeeHttpService;
}

interface CatalogHarnessOptions {
  plugins: readonly EcobeePlugin[];
  catalogLoader: ToolCatalogLoader;
}

const openClients: Client[] = [];
const openHarnesses: Harness[] = [];

afterEach(async () => {
  await Promise.allSettled(
    openClients.splice(0).map((client) => client.close()),
  );
  for (const harness of openHarnesses.splice(0)) {
    await harness.service.close();
    harness.httpServer.closeAllConnections();
    if (harness.httpServer.listening) {
      await new Promise<void>((resolve) =>
        harness.httpServer.close(() => resolve()),
      );
    }
  }
});

describe("modern MCP HTTP endpoint", () => {
  it("negotiates only 2026-07-28 through server/discover", async () => {
    const observedBodies: unknown[] = [];
    const harness = await startHarness();
    const client = await connectModern(
      harness.endpoint,
      AUTH_TOKEN,
      async (input, init) => {
        if (typeof init?.body === "string")
          observedBodies.push(JSON.parse(init.body));
        return fetch(input, init);
      },
    );

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
    expect(client.getServerVersion()).toEqual({
      name: "ecobee-mcp",
      version: SERVICE_VERSION,
    });
    expect(client.getDiscoverResult()?.supportedVersions).toEqual([
      MCP_PROTOCOL_VERSION,
    ]);
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });

    await client.listTools();
    const toolsList = observedBodies.find(
      (body) => isJsonRpcRequest(body) && body.method === "tools/list",
    );
    expect(toolsList).toBeDefined();
    if (!isJsonRpcRequest(toolsList))
      throw new Error("tools/list was not captured");
    const metadata = toolsList.params?._meta as Record<string, unknown>;
    expect(metadata[PROTOCOL_VERSION_META_KEY]).toBe(MCP_PROTOCOL_VERSION);
    expect(metadata[CLIENT_CAPABILITIES_META_KEY]).toEqual({});
  });

  it("returns the complete stable tool inventory and exact safety annotations", async () => {
    const harness = await startHarness();
    const client = await connectModern(harness.endpoint);
    const { tools, nextCursor } = await client.listTools();

    expect(nextCursor).toBeUndefined();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(
        READ_TOOLS.includes(tool.name as (typeof READ_TOOLS)[number]),
      );
      expect(tool.annotations?.readOnlyHint).toBe(
        !MUTATION_TOOLS.includes(tool.name as (typeof MUTATION_TOOLS)[number]),
      );
      assertBoundedSchema(tool.inputSchema, `${tool.name}.inputSchema`);
      assertBoundedSchema(tool.outputSchema, `${tool.name}.outputSchema`);
    }

    const schemaDigest = createHash("sha256")
      .update(
        canonicalJson(
          tools.map(({ name, inputSchema, outputSchema, annotations }) => ({
            name,
            inputSchema,
            outputSchema,
            annotations,
          })),
        ),
      )
      .digest("hex");
    expect(schemaDigest).toBe(
      "b3a695a0a28b6af6bb27946b45c30289ac541efa277dcdc701576cb7276537fe",
    );
  });

  it("publishes one atomic catalog change through a modern subscription", async () => {
    let plugins: readonly EcobeePlugin[] = [
      catalogPlugin("catalog_kept", "old"),
      catalogPlugin("catalog_removed", "old"),
    ];
    const api = createFakeApi();
    const catalogLoader = vi.fn(async () => plugins);
    const harness = await startHarness(api, true, {
      plugins,
      catalogLoader,
    });
    const client = await connectModern(harness.endpoint);

    expect(client.getServerCapabilities()?.tools).toEqual({
      listChanged: true,
    });
    const initial = await client.listTools();
    const initialInfo = harness.service.catalog();
    expect(catalogFingerprint(initial.tools)).toBe(initialInfo.fingerprint);
    expect(catalogLoader).not.toHaveBeenCalled();

    let notifications = 0;
    let notificationReceived!: () => void;
    const notified = new Promise<void>((resolve) => {
      notificationReceived = resolve;
    });
    client.setNotificationHandler(
      "notifications/tools/list_changed",
      async () => {
        notifications++;
        notificationReceived();
      },
    );
    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });

    plugins = [
      catalogPlugin("catalog_removed", "old"),
      catalogPlugin("catalog_kept", "old", undefined, "refreshed-handler"),
    ];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: true,
      changed: false,
      fingerprint: initialInfo.fingerprint,
      generation: initialInfo.generation + 1,
    });
    expect(catalogLoader).toHaveBeenCalledTimes(1);
    expect(notifications).toBe(0);
    await expect(
      client.callTool({ name: "catalog_kept", arguments: {} }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "refreshed-handler" }],
      structuredContent: { revision: "old" },
    });

    plugins = [
      catalogPlugin("catalog_added", "new"),
      catalogPlugin("catalog_kept", "new"),
    ];
    const reload = await harness.service.reloadCatalog();
    expect(catalogLoader).toHaveBeenCalledTimes(2);
    expect(reload).toMatchObject({
      accepted: true,
      changed: true,
      generation: 3,
    });
    await notified;
    expect(notifications).toBe(1);

    const updated = await client.listTools();
    expect(catalogFingerprint(updated.tools)).toBe(reload.fingerprint);
    expect(updated.tools.map(({ name }) => name).sort()).toEqual(
      [...EXPECTED_TOOLS, "catalog_added", "catalog_kept"].sort(),
    );
    expect(updated.tools.some(({ name }) => name === "catalog_removed")).toBe(
      false,
    );
    const changed = updated.tools.find(({ name }) => name === "catalog_kept");
    expect(changed).toMatchObject({
      description: "Catalog test tool new",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: {
        type: "object",
        properties: { revision: { type: "string", const: "new" } },
        required: ["revision"],
        additionalProperties: false,
      },
      _meta: {
        "test/source": "new",
        [CATALOG_FINGERPRINT_META_KEY]: reload.fingerprint,
      },
    });
    expect(changed?.inputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(changed?.outputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { revision: { type: "string", const: "new" } },
      required: ["revision"],
      additionalProperties: false,
    });
    expect(updated.tools.some(({ name }) => name === "catalog_added")).toBe(
      true,
    );

    await subscription.close();
    await client.close();
    const reconnected = await connectModern(harness.endpoint);
    const reconnectedTools = await reconnected.listTools();
    expect(catalogFingerprint(reconnectedTools.tools)).toBe(reload.fingerprint);
    expect(reconnectedTools.tools.map(({ name }) => name).sort()).toEqual(
      [...EXPECTED_TOOLS, "catalog_added", "catalog_kept"].sort(),
    );
    expect(
      reconnectedTools.tools.some(({ name }) => name === "catalog_removed"),
    ).toBe(false);
    for (const call of allApiSpies(api)) expect(call).not.toHaveBeenCalled();
  });

  it("retains last-good catalog and emits nothing for rejected candidates", async () => {
    let plugins: readonly EcobeePlugin[] = [
      catalogPlugin("catalog_valid", "one"),
    ];
    const api = createFakeApi();
    const harness = await startHarness(api, true, {
      plugins,
      catalogLoader: async () => plugins,
    });
    const client = await connectModern(harness.endpoint);
    const initial = await client.listTools();
    const initialInfo = harness.service.catalog();
    let notifications = 0;
    let validNotification!: () => void;
    const validNotified = new Promise<void>((resolve) => {
      validNotification = resolve;
    });
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notifications++;
      validNotification();
    });
    const subscription = await client.listen({ toolsListChanged: true });

    plugins = [{ name: "" } as EcobeePlugin];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: false,
      changed: false,
      fingerprint: initialInfo.fingerprint,
      generation: initialInfo.generation,
    });

    plugins = [malformedSchemaPlugin()];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: false,
      changed: false,
      fingerprint: initialInfo.fingerprint,
      generation: initialInfo.generation,
    });

    plugins = [unboundedCompositeSchemaPlugin()];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: false,
      changed: false,
      fingerprint: initialInfo.fingerprint,
      generation: initialInfo.generation,
    });

    plugins = [catalogPlugin("list_thermostats", "collision")];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: false,
      changed: false,
      fingerprint: initialInfo.fingerprint,
      generation: initialInfo.generation,
    });
    expect(harness.service.catalog()).toEqual(initialInfo);

    plugins = [catalogPlugin("catalog_valid", "two")];
    const valid = await harness.service.reloadCatalog();
    expect(valid).toMatchObject({ accepted: true, changed: true });
    await validNotified;
    expect(notifications).toBe(1);

    const updated = await client.listTools();
    expect(catalogFingerprint(updated.tools)).toBe(valid.fingerprint);
    expect(catalogFingerprint(initial.tools)).toBe(initialInfo.fingerprint);
    for (const call of allApiSpies(api)) expect(call).not.toHaveBeenCalled();
    await subscription.close();
  });

  it("keeps an in-flight tool call on its captured catalog snapshot", async () => {
    const executions: string[] = [];
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    let plugins: readonly EcobeePlugin[] = [
      inFlightCatalogPlugin(
        "old",
        async () => {
          oldStarted();
          await release;
        },
        () => executions.push("old"),
      ),
    ];
    const api = createFakeApi();
    const harness = await startHarness(api, true, {
      plugins,
      catalogLoader: async () => plugins,
    });
    const client = await connectModern(harness.endpoint);
    await client.listTools();

    const oldCall = client.request({
      method: "tools/call",
      params: {
        name: "catalog_slow",
        arguments: {},
      },
    });
    await started;
    plugins = [
      inFlightCatalogPlugin("new", undefined, () => executions.push("new")),
    ];
    expect(await harness.service.reloadCatalog()).toMatchObject({
      accepted: true,
      changed: true,
    });
    releaseOld();
    expect(executions).toEqual([]);
    const oldResult = await oldCall;
    expect({ oldResult, executions }).toMatchObject({
      oldResult: { structuredContent: { revision: "old" } },
      executions: ["old"],
    });
    const currentClient = await connectModern(harness.endpoint);
    await currentClient.listTools();
    await expect(
      currentClient.request({
        method: "tools/call",
        params: { name: "catalog_slow", arguments: {} },
      }),
    ).resolves.toMatchObject({ structuredContent: { revision: "new" } });
    for (const call of allApiSpies(api)) expect(call).not.toHaveBeenCalled();
  });

  it("compresses large discovery responses without taxing small reads", async () => {
    const harness = await startHarness();
    const toolsResponse = await fetch(harness.endpoint, {
      method: "POST",
      headers: modernHeaders("tools/list", undefined, AUTH_TOKEN),
      body: modernBody(1, "tools/list", {}),
    });
    expect(toolsResponse.status).toBe(200);
    expect(toolsResponse.headers.get("content-encoding")).toBe("gzip");
    expect(
      (await toolsResponse.json()) as { result?: { tools?: unknown[] } },
    ).toMatchObject({ result: { tools: expect.any(Array) } });

    const statusResponse = await fetch(harness.endpoint, {
      method: "POST",
      headers: modernHeaders("tools/call", "get_thermostat_status", AUTH_TOKEN),
      body: modernBody(2, "tools/call", {
        name: "get_thermostat_status",
        arguments: {},
      }),
    });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.headers.get("content-encoding")).toBeNull();
  });

  it("executes a structured read with the official v2 client", async () => {
    const harness = await startHarness();
    const client = await connectModern(harness.endpoint);
    await client.listTools();

    const result = await client.callTool({
      name: "list_thermostats",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      thermostats: [
        {
          id: "123",
          name: "Main",
          model: "ecobee-test",
          connected: true,
        },
      ],
    });
  });

  it("preserves discovery and reads with SDK performance caches disabled", async () => {
    const harness = await startHarness(createFakeApi(), false);
    const client = await connectModern(harness.endpoint);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);

    const result = await client.callTool({
      name: "list_thermostats",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      thermostats: [
        {
          id: "123",
          name: "Main",
          model: "ecobee-test",
          connected: true,
        },
      ],
    });
  });

  it("discovers and reads the three bounded Ecobee resources", async () => {
    const harness = await startHarness();
    const client = await connectModern(harness.endpoint);
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri).sort();
    expect(uris).toEqual([
      "ecobee://thermostat/sensors",
      "ecobee://thermostat/status",
      "ecobee://thermostat/weather",
    ]);

    for (const uri of uris) {
      const result = await client.readResource({ uri });
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect("text" in content ? content.text.length : 0).toBeLessThan(
        256 * 1024,
      );
    }
  });

  it("proves no read-only tool can execute a write", async () => {
    const harness = await startHarness();
    const client = await connectModern(harness.endpoint);
    await client.listTools();

    const args: Record<(typeof READ_TOOLS)[number], Record<string, unknown>> = {
      list_thermostats: {},
      get_thermostat_status: { thermostatId: "123" },
      get_sensors: { thermostatId: "123" },
      get_weather: { thermostatId: "123" },
      get_schedule: { thermostatId: "123" },
      list_vacations: { thermostatId: "123" },
      get_alerts: { thermostatId: "123" },
      get_runtime_report: {
        thermostatId: "123",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
      },
      get_extended_runtime: { thermostatId: "123" },
      get_demand_response: { thermostatId: "123" },
      get_utility_info: { thermostatId: "123" },
      get_technician_info: { thermostatId: "123" },
      get_house_details: { thermostatId: "123" },
      list_groups: {},
    };

    for (const name of READ_TOOLS) {
      const result = await client.callTool({ name, arguments: args[name] });
      expect(result.isError, name).not.toBe(true);
    }

    for (const write of writeSpies(harness.api)) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("requires bearer authentication without revealing the configured token", async () => {
    const harness = await startHarness();
    const noAuthClient = new Client(
      { name: "official-v2-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    openClients.push(noAuthClient);
    const transport = new StreamableHTTPClientTransport(harness.endpoint);

    await expect(noAuthClient.connect(transport)).rejects.toThrow();
    const response = await fetch(harness.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(AUTH_TOKEN);
  });

  it("rejects malformed tool arguments before any Ecobee write", async () => {
    const harness = await startHarness();
    const client = await connectModern(harness.endpoint);
    await client.listTools();

    const result = await client.callTool({
      name: "set_temperature",
      arguments: { thermostatId: "123", heatTemp: 1_000 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(1_024);
    for (const write of writeSpies(harness.api)) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("rejects the legacy initialize handshake instead of serving a compatibility stack", async () => {
    const harness = await startHarness();
    const legacyClient = new Client({ name: "legacy-test", version: "1.0.0" });
    openClients.push(legacyClient);
    const transport = new StreamableHTTPClientTransport(harness.endpoint, {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    });

    await expect(legacyClient.connect(transport)).rejects.toThrow();
    expect(legacyClient.getProtocolEra()).toBeUndefined();
  });

  it("bounds malformed requests and exposes a secret-free health response", async () => {
    const harness = await startHarness();
    const malformed = await fetch(harness.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.text()).length).toBeLessThan(512);

    const oversized = await fetch(harness.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(257 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.text()).length).toBeLessThan(512);

    const health = await fetch(new URL("/health", harness.endpoint));
    expect(await health.json()).toEqual({
      status: "ok",
      serviceVersion: SERVICE_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      authentication: "bearer-required",
    });
    expect(await serializeResponse(health)).not.toContain(AUTH_TOKEN);
  });

  it("keeps secrets out of serialized results, logs, errors, and health output", async () => {
    const secrets = [
      "access-secret",
      "refresh-secret",
      "client-secret",
      "authorization-code-secret",
      "ecobee-pin-secret",
    ];
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const api = createFakeApi({
      getThermostats: vi
        .fn()
        .mockRejectedValue(
          new Error(
            `access_token=${secrets[0]} refresh_token=${secrets[1]} ` +
              `client_secret=${secrets[2]} authorization_code=${secrets[3]} pin=${secrets[4]}`,
          ),
        ),
    });
    const harness = await startHarness(api);
    const client = await connectModern(harness.endpoint);
    await client.listTools();

    const result = await client.callTool({
      name: "list_thermostats",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const health = await fetch(new URL("/health", harness.endpoint));
    const combined = JSON.stringify({
      result,
      logs: errorLog.mock.calls,
      health: await health.json(),
    });
    for (const secret of secrets) expect(combined).not.toContain(secret);
  });

  it("propagates official-client aborts to the MCP request stream", async () => {
    let currentSignal: AbortSignal | undefined;
    let startedResolve!: () => void;
    let abortedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    const api = createFakeApi({
      withRequestSignal: async <T>(
        signal: AbortSignal,
        operation: () => Promise<T>,
      ) => {
        currentSignal = signal;
        return operation();
      },
      getThermostats: vi.fn(async () => {
        startedResolve();
        return new Promise((_, reject) => {
          currentSignal?.addEventListener(
            "abort",
            () => {
              abortedResolve();
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      }),
    });
    const harness = await startHarness(api);
    const client = await connectModern(harness.endpoint);
    await client.listTools();
    const controller = new AbortController();

    const call = client.callTool(
      { name: "list_thermostats", arguments: {} },
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(call).rejects.toThrow();
    await expect(aborted).resolves.toBeUndefined();
  });
});

async function startHarness(
  api = createFakeApi(),
  performanceCaches = true,
  catalogOptions?: CatalogHarnessOptions,
): Promise<Harness> {
  const service = await createHttpService({
    api,
    cache: new EcobeeCache(),
    plugins: catalogOptions ? [...catalogOptions.plugins] : undefined,
    catalogLoader: catalogOptions?.catalogLoader,
    authToken: AUTH_TOKEN,
    performanceCaches,
  });
  const httpServer = service.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const harness = {
    api,
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    httpServer,
    service,
  };
  openHarnesses.push(harness);
  return harness;
}

async function connectModern(
  endpoint: URL,
  token = AUTH_TOKEN,
  fetchFn?: typeof fetch,
): Promise<Client> {
  const client = new Client(
    { name: "official-v2-test", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  openClients.push(client);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchFn,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function catalogPlugin(
  toolName: string,
  revision: string,
  beforeResult?: () => Promise<void>,
  responseText = revision,
): EcobeePlugin {
  const inputSchema = fromJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  const outputSchema = fromJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { revision: { type: "string", const: revision } },
    required: ["revision"],
    additionalProperties: false,
  });
  return {
    name: `plugin-${toolName}`,
    registerTools(catalog: ToolCatalogRegistrar) {
      catalog.registerTool(
        toolName,
        {
          description: `Catalog test tool ${revision}`,
          inputSchema,
          outputSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: { "test/source": revision },
        },
        async () => {
          await beforeResult?.();
          return {
            content: [{ type: "text", text: responseText }],
            structuredContent: { revision },
          };
        },
      );
    },
  };
}

function malformedSchemaPlugin(): EcobeePlugin {
  const malformed = fromJsonSchema({
    type: "not-a-json-schema-type",
  } as unknown as JsonSchemaType);
  return {
    name: "malformed-schema",
    registerTools(catalog) {
      catalog.registerTool(
        "catalog_malformed",
        {
          inputSchema: malformed,
          outputSchema: malformed,
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: "text", text: "unreachable" }] }),
      );
    },
  };
}

function unboundedCompositeSchemaPlugin(): EcobeePlugin {
  const inputSchema = fromJsonSchema({
    type: "object",
    properties: {
      value: {
        oneOf: [{ type: "string" }, { type: "array", items: {} }],
      },
    },
    additionalProperties: false,
  });
  const outputSchema = fromJsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  return {
    name: "unbounded-composite-schema",
    registerTools(catalog) {
      catalog.registerTool(
        "catalog_unbounded_composite",
        {
          inputSchema,
          outputSchema,
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: "text", text: "unreachable" }] }),
      );
    },
  };
}

function inFlightCatalogPlugin(
  revision: string,
  beforeResult?: () => Promise<void>,
  returning?: () => void,
): EcobeePlugin {
  const inputSchema = fromJsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  const outputSchema = fromJsonSchema({
    type: "object",
    properties: { revision: { type: "string", maxLength: 8 } },
    required: ["revision"],
    additionalProperties: false,
  });
  return {
    name: "plugin-catalog-slow",
    registerTools(catalog) {
      catalog.registerTool(
        "catalog_slow",
        {
          description: `In-flight snapshot ${revision}`,
          inputSchema,
          outputSchema,
          annotations: { readOnlyHint: true },
        },
        async () => {
          await beforeResult?.();
          returning?.();
          return {
            content: [{ type: "text", text: revision }],
            structuredContent: { revision },
          };
        },
      );
    },
  };
}

function catalogFingerprint(
  tools: Array<{ _meta?: Record<string, unknown> }>,
): string {
  const values = new Set(
    tools.map((tool) => tool._meta?.[CATALOG_FINGERPRINT_META_KEY]),
  );
  expect(values.size).toBe(1);
  const fingerprint = [...values][0];
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  return String(fingerprint);
}

function createFakeApi(
  overrides: Record<string, unknown> = {},
): EcobeeApiClient {
  const thermostat = {
    identifier: "123",
    name: "Main",
    modelNumber: "ecobee-test",
    thermostatTime: "2026-08-17 12:00:00",
    runtime: {
      connected: true,
      actualTemperature: 710,
      actualHumidity: 42,
      desiredHeat: 680,
      desiredCool: 760,
    },
    settings: { hvacMode: "auto", drAccept: "always" },
    program: {
      currentClimateRef: "home",
      schedule: Array.from({ length: 7 }, () => Array(48).fill("home")),
      climates: [
        {
          name: "Home",
          climateRef: "home",
          type: "program",
          isOccupied: true,
          coolFan: "auto",
          heatFan: "auto",
          coolTemp: 760,
          heatTemp: 680,
        },
      ],
    },
    events: [],
    alerts: [],
    remoteSensors: [],
    weather: {
      timestamp: "2026-08-17 12:00:00",
      weatherStation: "TEST",
      forecasts: [],
    },
    houseDetails: {
      style: "detached",
      size: 1800,
      numberOfFloors: 2,
      numberOfRooms: 8,
      numberOfOccupants: 3,
      age: 25,
      windowEfficiency: 4,
    },
    technician: {
      contractorRef: "contractor-1",
      name: "Test HVAC",
      phone: "555-0100",
      streetAddress: "1 Test Way",
      city: "Testville",
      provinceState: "IN",
      country: "US",
      postalCode: "46000",
      email: "service@example.invalid",
      web: "https://example.invalid",
    },
    utility: {
      name: "Test Utility",
      phone: "555-0101",
      email: "utility@example.invalid",
      web: "https://example.invalid",
    },
    equipmentStatus: "",
  };
  const base = {
    withRequestSignal: async <T>(
      _signal: AbortSignal,
      operation: () => Promise<T>,
    ) => operation(),
    getThermostats: vi.fn().mockResolvedValue([thermostat]),
    getThermostatSummary: vi.fn().mockResolvedValue({
      revisionList: [],
      thermostatCount: 1,
      statusList: [],
    }),
    getRuntimeReport: vi.fn().mockResolvedValue({
      startDate: "2026-08-01",
      startInterval: 0,
      endDate: "2026-08-01",
      endInterval: 0,
      columns: "",
      reportList: [],
      sensorList: [],
      status: { code: 0, message: "" },
    }),
    getGroups: vi.fn().mockResolvedValue([]),
    updateThermostat: vi.fn().mockResolvedValue(undefined),
    setHold: vi.fn().mockResolvedValue(undefined),
    resumeProgram: vi.fn().mockResolvedValue(undefined),
    setHvacMode: vi.fn().mockResolvedValue(undefined),
    createVacation: vi.fn().mockResolvedValue(undefined),
    createVacationsBulk: vi.fn().mockResolvedValue(undefined),
    deleteVacation: vi.fn().mockResolvedValue(undefined),
    acknowledgeAlert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    updateComfortProfile: vi.fn().mockResolvedValue(undefined),
    updateGroups: vi.fn().mockResolvedValue([]),
  };
  return { ...base, ...overrides } as unknown as EcobeeApiClient;
}

function writeSpies(api: EcobeeApiClient): Array<ReturnType<typeof vi.fn>> {
  return [
    api.updateThermostat,
    api.setHold,
    api.resumeProgram,
    api.setHvacMode,
    api.createVacation,
    api.createVacationsBulk,
    api.deleteVacation,
    api.acknowledgeAlert,
    api.sendMessage,
    api.updateComfortProfile,
    api.updateGroups,
  ] as Array<ReturnType<typeof vi.fn>>;
}

function allApiSpies(api: EcobeeApiClient): Array<ReturnType<typeof vi.fn>> {
  return [
    api.getThermostats,
    api.getThermostatSummary,
    api.getRuntimeReport,
    api.getGroups,
    ...writeSpies(api),
  ] as Array<ReturnType<typeof vi.fn>>;
}

function isJsonRpcRequest(value: unknown): value is {
  method: string;
  params?: { _meta?: unknown };
} {
  return typeof value === "object" && value !== null && "method" in value;
}

function assertBoundedSchema(schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null) return;
  const node = schema as Record<string, unknown>;
  if (
    node.type === "string" &&
    node.enum === undefined &&
    node.const === undefined
  ) {
    expect(node.maxLength, `${path} must bound strings`).toEqual(
      expect.any(Number),
    );
  }
  if (node.type === "array") {
    expect(node.maxItems, `${path} must bound arrays`).toEqual(
      expect.any(Number),
    );
  }
  if (node.type === "number" || node.type === "integer") {
    expect(node.minimum, `${path} must have a numeric minimum`).toEqual(
      expect.any(Number),
    );
    expect(node.maximum, `${path} must have a numeric maximum`).toEqual(
      expect.any(Number),
    );
  }
  if (node.type === "object" && typeof node.additionalProperties === "object") {
    expect(
      node.maxProperties,
      `${path} must bound dynamic object keys`,
    ).toEqual(expect.any(Number));
  }
  if (node.type === "object" && node.properties !== undefined) {
    expect(
      node.additionalProperties,
      `${path} must reject unknown properties`,
    ).toBe(false);
  }
  for (const [key, child] of Object.entries(node)) {
    if (["description", "default", "examples"].includes(key)) continue;
    if (Array.isArray(child)) {
      child.forEach((item, index) =>
        assertBoundedSchema(item, `${path}.${key}[${index}]`),
      );
    } else {
      assertBoundedSchema(child, `${path}.${key}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function modernBody(
  id: number,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

function modernHeaders(
  method: string,
  name: string | undefined,
  token: string,
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "accept-encoding": "gzip",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(name ? { "mcp-name": name } : {}),
  };
}

async function serializeResponse(response: Response): Promise<string> {
  return JSON.stringify({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  });
}
