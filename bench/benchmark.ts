import { mkdir, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { request as httpRequest } from "node:http";
import { Session } from "node:inspector";
import { once } from "node:events";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { MCP_PROTOCOL_VERSION } from "../src/constants.js";
import { EcobeeCache } from "../src/ecobee/cache.js";
import { createHttpService } from "../src/http.js";
import { createBenchmarkApi, createTransportBenchmarkApi } from "./fake-api.js";

interface ScenarioResult {
  name: string;
  requests: number;
  concurrency: number;
  throughputPerSecond: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
  };
  responseBytesMean: number;
  cpuMs: number;
  eventLoopUtilization: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  heapDeltaBytes: number;
}

interface JsonRpcResponse {
  error?: { code: number; message: string };
}

const profileDir = process.env.PERF_PROFILE_DIR;
const profileLabel = process.env.PERF_PROFILE_LABEL ?? "profile";
const requestScale = boundedInteger(process.env.PERF_REQUEST_SCALE, 1, 1, 20);
const performanceCaches = process.env.MCP_PERFORMANCE_CACHES !== "0";
let requestId = 1;

const api = createBenchmarkApi();
const transportApi = createTransportBenchmarkApi();
const cache = new EcobeeCache();
const service = await createHttpService({ api, cache, performanceCaches });
const listener = service.app.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
if (!address || typeof address === "string") {
  throw new Error("Benchmark server did not bind to a TCP port.");
}
const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

const client = new Client(
  { name: "performance-harness", version: "1.0.0" },
  {
    capabilities: {},
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  },
);
await client.connect(new StreamableHTTPClientTransport(endpoint));
await client.listTools();
await client.callTool({ name: "get_thermostat_status", arguments: {} });
globalThis.gc?.();
const afterWarmupMemory = processMemorySnapshot();

const profiler = profileDir ? createPerformanceProfiler() : undefined;
if (profiler && profileDir) {
  await mkdir(profileDir, { recursive: true });
  await profiler.start();
}

const scenarios: ScenarioResult[] = [];
let wireSizes:
  | Record<string, { contentEncoding: string; responseBytes: number }>
  | undefined;
let afterWorkloadMemory: ReturnType<typeof processMemorySnapshot> | undefined;
try {
  scenarios.push(
    await runScenario("tools_list_sequential", 400 * requestScale, 1, () =>
      mcpRequest("tools/list", {}),
    ),
  );
  scenarios.push(
    await runScenario("cached_status_sequential", 600 * requestScale, 1, () =>
      mcpRequest("tools/call", {
        name: "get_thermostat_status",
        arguments: {},
      }),
    ),
  );
  scenarios.push(
    await runScenario(
      "cached_status_concurrency_16",
      1_600 * requestScale,
      16,
      () =>
        mcpRequest("tools/call", {
          name: "get_thermostat_status",
          arguments: {},
        }),
    ),
  );
  scenarios.push(
    await runScenario(
      "runtime_intervals_sequential",
      120 * requestScale,
      1,
      () =>
        mcpRequest("tools/call", {
          name: "get_runtime_report",
          arguments: {
            thermostatId: "benchmark-thermostat",
            startDate: "2026-08-01",
            endDate: "2026-08-01",
            summarize: false,
          },
        }),
    ),
  );
  scenarios.push(
    await runScenario(
      "ecobee_chunked_512k_sequential",
      60 * requestScale,
      1,
      async () => {
        await transportApi.getThermostats({
          selectionType: "registered",
          selectionMatch: "",
        });
        return 512 * 1024;
      },
    ),
  );
  wireSizes = {
    toolsList: await rawMcpRequest("tools/list", {}),
    cachedStatus: await rawMcpRequest("tools/call", {
      name: "get_thermostat_status",
      arguments: {},
    }),
    runtimeIntervals: await rawMcpRequest("tools/call", {
      name: "get_runtime_report",
      arguments: {
        thermostatId: "benchmark-thermostat",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        summarize: false,
      },
    }),
  };
  globalThis.gc?.();
  afterWorkloadMemory = processMemorySnapshot();
} finally {
  if (profiler && profileDir) {
    const profiles = await profiler.stop();
    await writeFile(
      `${profileDir}/${profileLabel}.cpuprofile`,
      JSON.stringify(profiles.cpu),
    );
    await writeFile(
      `${profileDir}/${profileLabel}.heapprofile`,
      JSON.stringify(profiles.heap),
    );
  }
  await client.close();
  await closeServer(listener);
  await service.close();
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  protocolVersion: MCP_PROTOCOL_VERSION,
  performanceCaches,
  requestScale,
  processMemory: {
    afterWarmup: afterWarmupMemory,
    afterWorkload: afterWorkloadMemory,
  },
  scenarios,
  wireSizes,
};
console.log(JSON.stringify(report, null, 2));
if (profileDir) {
  await writeFile(
    `${profileDir}/${profileLabel}-benchmark.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function runScenario(
  name: string,
  requests: number,
  concurrency: number,
  operation: () => Promise<number>,
): Promise<ScenarioResult> {
  const warmupRequests = Math.max(20, Math.min(100, Math.floor(requests / 5)));
  await runWorkers(warmupRequests, concurrency, operation);
  globalThis.gc?.();

  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const startElu = performance.eventLoopUtilization();
  const startCpu = process.cpuUsage();
  const startHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const measurements = await runWorkers(requests, concurrency, operation);
  const durationMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(startCpu);
  const elu = performance.eventLoopUtilization(startElu);
  delay.disable();
  globalThis.gc?.();

  const latencies = measurements
    .map(({ latencyMs }) => latencyMs)
    .sort((left, right) => left - right);
  const responseBytes = measurements.reduce(
    (total, measurement) => total + measurement.responseBytes,
    0,
  );

  return {
    name,
    requests,
    concurrency,
    throughputPerSecond: round((requests * 1_000) / durationMs),
    latencyMs: {
      min: round(latencies[0] ?? 0),
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) ?? 0),
      mean: round(
        latencies.reduce((total, latency) => total + latency, 0) /
          latencies.length,
      ),
    },
    responseBytesMean: round(responseBytes / requests),
    cpuMs: round((cpu.user + cpu.system) / 1_000),
    eventLoopUtilization: round(elu.utilization),
    eventLoopDelayMs: {
      p50: round(delay.percentile(50) / 1_000_000),
      p99: round(delay.percentile(99) / 1_000_000),
      max: round(delay.max / 1_000_000),
    },
    heapDeltaBytes: process.memoryUsage().heapUsed - startHeap,
  };
}

async function runWorkers(
  requests: number,
  concurrency: number,
  operation: () => Promise<number>,
): Promise<Array<{ latencyMs: number; responseBytes: number }>> {
  const measurements = new Array<{
    latencyMs: number;
    responseBytes: number;
  }>(requests);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(requests, concurrency) }, async () => {
      while (true) {
        const index = next++;
        if (index >= requests) return;
        const startedAt = performance.now();
        const responseBytes = await operation();
        measurements[index] = {
          latencyMs: performance.now() - startedAt,
          responseBytes,
        };
      }
    }),
  );
  return measurements;
}

async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `MCP benchmark request failed with HTTP ${response.status}: ${text.slice(0, 512)}`,
    );
  }
  const result = JSON.parse(text) as JsonRpcResponse;
  if (result.error) {
    throw new Error(
      `MCP benchmark request failed with ${result.error.code}: ${result.error.message}`,
    );
  }
  return Buffer.byteLength(text, "utf8");
}

function rawMcpRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<{ contentEncoding: string; responseBytes: number }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "accept-encoding": "gzip",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          "mcp-method": method,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {}),
        },
      },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Raw MCP benchmark request failed with HTTP ${response.statusCode}.`,
              ),
            );
            return;
          }
          resolve({
            contentEncoding: String(
              response.headers["content-encoding"] ?? "identity",
            ),
            responseBytes: bytes,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((value / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function processMemorySnapshot(): {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
} {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createPerformanceProfiler(): {
  start: () => Promise<void>;
  stop: () => Promise<{ cpu: unknown; heap: unknown }>;
} {
  const session = new Session();
  const post = <Result>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Result> => {
    return new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => {
        if (error) reject(error);
        else resolve(result as Result);
      });
    });
  };

  return {
    async start() {
      session.connect();
      await post("Profiler.enable");
      await post("HeapProfiler.enable");
      await post("Profiler.start");
      await post("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    },
    async stop() {
      const cpu = await post<{ profile: unknown }>("Profiler.stop");
      const heap = await post<{ profile: unknown }>(
        "HeapProfiler.stopSampling",
      );
      session.disconnect();
      return { cpu: cpu.profile, heap: heap.profile };
    },
  };
}
