import { AsyncLocalStorage } from "node:async_hooks";
import { SpanKind } from "@opentelemetry/api";
import { activeSpan, traceOperation } from "../observability.js";
import type { EcobeeAuth } from "./auth.js";
import type {
  EcobeeApiResponse,
  Group,
  GroupResponse,
  RuntimeReportRequest,
  RuntimeReportResponse,
  Thermostat,
  ThermostatFunction,
  ThermostatSelection,
  ThermostatSummary,
  ThermostatUpdateBody,
} from "./types.js";

const ECOBEE_API_BASE = "https://api.ecobee.com/1";
/** Ecobee status.code for an expired access token. Reported with HTTP 500, not 401. */
const ECOBEE_TOKEN_EXPIRED = 14;
const MAX_CONCURRENT = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RATE_LIMIT_WAIT_MS = 2_000;

export interface EcobeeApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Ecobee REST API client with concurrency limiting.
 * Max 2 concurrent requests to avoid rate limiting.
 */
export class EcobeeApiClient {
  private activeRequests = 0;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly requestContext = new AsyncLocalStorage<{
    signal: AbortSignal;
  }>();

  constructor(
    private readonly auth: EcobeeAuth,
    private readonly options: EcobeeApiClientOptions = {},
  ) {}

  /** Propagate the MCP request's stream-close cancellation into Ecobee I/O. */
  async withRequestSignal<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.requestContext.run({ signal }, operation);
  }

  /* v8 ignore start -- Integration test: getThermostatSummary HTTP call.
     Test with mock HTTP server, verify query string encoding of selection. */
  /** Get thermostat summary (lightweight status check). */
  async getThermostatSummary(): Promise<ThermostatSummary> {
    const selection = {
      selectionType: "registered",
      selectionMatch: "",
    };
    const body = JSON.stringify({ selection });
    const params = new URLSearchParams({ json: body });
    const resp = await this.request<ThermostatSummary>(
      "GET",
      `/thermostatSummary?${params}`,
    );
    return resp;
  }
  /* v8 ignore stop */

  /** Get thermostats with selective includes. */
  async getThermostats(selection: ThermostatSelection): Promise<Thermostat[]> {
    const body = JSON.stringify({ selection });
    const params = new URLSearchParams({ json: body });
    const resp = await this.request<EcobeeApiResponse>(
      "GET",
      `/thermostat?${params}`,
    );
    return resp.thermostatList ?? [];
  }

  /* v8 ignore start -- Integration test: HTTP API methods.
     All methods below construct request bodies and call this.request() which
     makes real HTTP calls to api.ecobee.com. Test with a mock HTTP server
     or Ecobee sandbox. Verify: request body shape, correct endpoint path,
     concurrency limiting, 401 retry, and Ecobee status.code error handling. */

  /** Update thermostat with functions (holds, vacations, etc.). */
  async updateThermostat(body: ThermostatUpdateBody): Promise<void> {
    await this.request<EcobeeApiResponse>("POST", "/thermostat", body);
  }

  /** Set a temperature hold. */
  async setHold(
    thermostatId: string,
    params: {
      holdType: "nextTransition" | "indefinite" | "dateTime";
      heatHoldTemp?: number;
      coolHoldTemp?: number;
      holdClimateRef?: string;
      endDate?: string;
      endTime?: string;
    },
  ): Promise<void> {
    const fn: ThermostatFunction = {
      type: "setHold",
      params: {
        holdType: params.holdType,
        ...(params.heatHoldTemp !== undefined && {
          heatHoldTemp: params.heatHoldTemp,
        }),
        ...(params.coolHoldTemp !== undefined && {
          coolHoldTemp: params.coolHoldTemp,
        }),
        ...(params.holdClimateRef && {
          holdClimateRef: params.holdClimateRef,
        }),
        ...(params.endDate && { endDate: params.endDate }),
        ...(params.endTime && { endTime: params.endTime }),
      },
    };

    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [fn],
    });
  }

  /** Resume normal program schedule. */
  async resumeProgram(
    thermostatId: string,
    resumeAll: boolean = false,
  ): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [
        {
          type: "resumeProgram",
          params: { resumeAll },
        },
      ],
    });
  }

  /** Set HVAC mode. */
  async setHvacMode(thermostatId: string, mode: string): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      thermostat: {
        settings: { hvacMode: mode } as Thermostat["settings"],
      },
    });
  }

  /** Create a vacation event. */
  async createVacation(
    thermostatId: string,
    params: {
      name: string;
      coolHoldTemp: number;
      heatHoldTemp: number;
      startDate: string;
      startTime: string;
      endDate: string;
      endTime: string;
    },
  ): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [
        {
          type: "createVacation",
          params: {
            name: params.name,
            coolHoldTemp: params.coolHoldTemp,
            heatHoldTemp: params.heatHoldTemp,
            startDate: params.startDate,
            startTime: params.startTime,
            endDate: params.endDate,
            endTime: params.endTime,
            fan: "auto",
            fanMinOnTime: 0,
          },
        },
      ],
    });
  }

  /** Create multiple vacations in a single API call. */
  async createVacationsBulk(
    thermostatId: string,
    vacations: Array<{
      name: string;
      coolHoldTemp: number;
      heatHoldTemp: number;
      startDate: string;
      startTime: string;
      endDate: string;
      endTime: string;
    }>,
  ): Promise<void> {
    const functions: ThermostatFunction[] = vacations.map((v) => ({
      type: "createVacation",
      params: {
        name: v.name,
        coolHoldTemp: v.coolHoldTemp,
        heatHoldTemp: v.heatHoldTemp,
        startDate: v.startDate,
        startTime: v.startTime,
        endDate: v.endDate,
        endTime: v.endTime,
        fan: "auto",
        fanMinOnTime: 0,
      },
    }));

    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions,
    });
  }

  /** Delete a vacation event by name. */
  async deleteVacation(thermostatId: string, name: string): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [
        {
          type: "deleteVacation",
          params: { name },
        },
      ],
    });
  }

  /** Acknowledge an alert. */
  async acknowledgeAlert(
    thermostatId: string,
    ackRef: string,
    ackType: "accept" | "decline" | "defer" | "unacknowledged",
  ): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [
        {
          type: "acknowledge",
          params: {
            thermostatIdentifier: thermostatId,
            ackRef,
            ackType,
          },
        },
      ],
    });
  }

  /** Send a message to the thermostat screen. */
  async sendMessage(thermostatId: string, text: string): Promise<void> {
    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      functions: [
        {
          type: "sendMessage",
          params: { text },
        },
      ],
    });
  }

  /** Update comfort profile temperatures. */
  async updateComfortProfile(
    thermostatId: string,
    climateRef: string,
    updates: { coolTemp?: number; heatTemp?: number },
  ): Promise<void> {
    // Fetch current program to get full climates array
    const thermostats = await this.getThermostats({
      selectionType: "thermostats",
      selectionMatch: thermostatId,
      includeProgram: true,
    });

    if (thermostats.length === 0) {
      throw new Error("Thermostat not found");
    }

    const program = thermostats[0].program;
    if (!program) {
      throw new Error("No program data available");
    }

    const climate = program.climates.find((c) => c.climateRef === climateRef);
    if (!climate) {
      throw new Error(`Climate "${climateRef}" not found`);
    }

    if (updates.coolTemp !== undefined) climate.coolTemp = updates.coolTemp;
    if (updates.heatTemp !== undefined) climate.heatTemp = updates.heatTemp;

    await this.updateThermostat({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId,
      },
      thermostat: {
        program: {
          schedule: program.schedule,
          climates: program.climates,
          currentClimateRef: program.currentClimateRef,
        },
      } as Partial<Thermostat>,
    });
  }

  /** Get runtime report data. */
  async getRuntimeReport(
    params: RuntimeReportRequest,
  ): Promise<RuntimeReportResponse> {
    const body = JSON.stringify(params);
    const qs = new URLSearchParams({ json: body });
    return this.request<RuntimeReportResponse>("GET", `/runtimeReport?${qs}`);
  }

  /** Get all thermostat groups. */
  async getGroups(): Promise<Group[]> {
    const body = JSON.stringify({
      selection: { selectionType: "registered" },
    });
    const params = new URLSearchParams({ json: body });
    const resp = await this.request<GroupResponse>("GET", `/group?${params}`);
    return resp.groups ?? [];
  }

  /** Create or update groups. Omit groupRef to create. Send empty thermostats array to delete. */
  async updateGroups(groups: Partial<Group>[]): Promise<Group[]> {
    const resp = await this.request<GroupResponse>("POST", "/group", {
      selection: { selectionType: "registered" },
      groups,
    });
    return resp.groups ?? [];
  }
  /* v8 ignore stop */

  // --- Internal request handling ---

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return traceOperation(
      "ecobee.request",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": method,
          "http.route": path.split("?", 1)[0],
          "server.address": "api.ecobee.com",
          "ecobee.request.mutation": method === "POST",
        },
      },
      async (span) => {
        const signal = this.requestContext.getStore()?.signal;
        const queuedAt = performance.now();
        await this.acquireSlot(signal);
        span.setAttribute(
          "ecobee.queue.duration_ms",
          performance.now() - queuedAt,
        );
        try {
          return await this.doRequest<T>(
            method,
            path,
            body,
            false,
            false,
            signal,
          );
        } finally {
          this.releaseSlot();
        }
      },
    );
  }

  private async doRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authRetried: boolean = false,
    rateLimitRetried: boolean = false,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const token = await this.auth.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const timeoutMs = boundedPositiveInteger(
      this.options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      120_000,
    );
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const combinedSignal = combineSignals(signal, timeoutController.signal);

    let response: Response;
    let responseText: string;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl ?? ECOBEE_API_BASE}${path}`,
        {
          method,
          headers,
          signal: combinedSignal,
          ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
        },
      );
      activeSpan()?.setAttribute("http.response.status_code", response.status);
      responseText = await readBoundedResponse(
        response,
        boundedPositiveInteger(
          this.options.maxResponseBytes,
          DEFAULT_MAX_RESPONSE_BYTES,
          16 * 1024 * 1024,
        ),
        combinedSignal,
      );
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (method === "POST") {
        throw new AmbiguousMutationDeliveryError();
      }
      if (error instanceof EcobeeResponseLimitError) throw error;
      if (timedOut) throw new EcobeeTimeoutError(timeoutMs);
      throw new EcobeeApiError("Ecobee request failed.", 502);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 && !authRetried) {
      // Token may be expired - try to refresh and retry once
      activeSpan()?.setAttribute("ecobee.auth.retried", true);
      await this.auth.handleUnauthorized();
      return this.doRequest<T>(
        method,
        path,
        body,
        true,
        rateLimitRetried,
        signal,
      );
    }

    if (response.status === 429) {
      if (method === "GET" && !rateLimitRetried) {
        activeSpan()?.setAttribute("ecobee.rate_limit.retried", true);
        const waitMs = retryAfterMs(response.headers?.get?.("retry-after"));
        await abortableDelay(waitMs, signal);
        return this.doRequest<T>(method, path, body, authRetried, true, signal);
      }
      throw new EcobeeRateLimitError();
    }

    /* v8 ignore start -- Integration test: non-401 HTTP error from Ecobee API.
       Test with mock HTTP server returning 500/503 after a non-retry request. */
    if (!response.ok) {
      // An expired access token is reported as HTTP 500 with status.code 14,
      // not as a 401, so the check above never catches it. Without this the
      // server keeps using a stale in-memory token until it is restarted: in
      // readonly mode it never notices that the owning app already refreshed.
      if (
        !authRetried &&
        parseEcobeeStatusCode(responseText) === ECOBEE_TOKEN_EXPIRED
      ) {
        activeSpan()?.setAttribute("ecobee.auth.retried", true);
        await this.auth.handleUnauthorized();
        return this.doRequest<T>(
          method,
          path,
          body,
          true,
          rateLimitRetried,
          signal,
        );
      }

      if (
        method === "POST" &&
        (response.status === 408 || response.status >= 500)
      ) {
        throw new AmbiguousMutationDeliveryError();
      }
      throw new EcobeeApiError(
        "Ecobee API rejected the request.",
        response.status,
        parseEcobeeStatusCode(responseText),
      );
    }
    /* v8 ignore stop */

    let data: EcobeeApiResponse;
    try {
      data = JSON.parse(responseText) as EcobeeApiResponse;
    } catch {
      if (method === "POST") throw new AmbiguousMutationDeliveryError();
      throw new EcobeeApiError("Ecobee returned invalid JSON.", 502);
    }

    // Ecobee API returns status.code !== 0 for logical errors
    if (data?.status?.code !== undefined && data.status.code !== 0) {
      // Same expiry case, but returned alongside a 2xx status.
      if (!authRetried && data.status.code === ECOBEE_TOKEN_EXPIRED) {
        activeSpan()?.setAttribute("ecobee.auth.retried", true);
        await this.auth.handleUnauthorized();
        return this.doRequest<T>(
          method,
          path,
          body,
          true,
          rateLimitRetried,
          signal,
        );
      }

      throw new EcobeeApiError(
        "Ecobee API rejected the request.",
        response.status,
        data.status.code,
      );
    }

    return data as T;
  }

  // --- Concurrency limiter ---

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.activeRequests < MAX_CONCURRENT) {
      this.activeRequests++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }
}

/**
 * Pull `status.code` out of an Ecobee error body. Returns undefined when the
 * body is not JSON or carries no status code, so a malformed error response
 * falls through to normal error handling rather than throwing here.
 */
function parseEcobeeStatusCode(text: string): number | undefined {
  try {
    const parsed = JSON.parse(text) as { status?: { code?: number } };
    return parsed?.status?.code;
  } catch {
    return undefined;
  }
}

export class EcobeeApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly ecobeeCode?: number,
  ) {
    super(message);
    this.name = "EcobeeApiError";
  }
}

export class EcobeeTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super("Ecobee request deadline exceeded.");
    this.name = "EcobeeTimeoutError";
  }
}

export class EcobeeResponseLimitError extends Error {
  constructor(public readonly limitBytes: number) {
    super("Ecobee response exceeded the configured size limit.");
    this.name = "EcobeeResponseLimitError";
  }
}

export class EcobeeRateLimitError extends Error {
  constructor() {
    super("Ecobee rate limit reached.");
    this.name = "EcobeeRateLimitError";
  }
}

export class AmbiguousMutationDeliveryError extends Error {
  constructor() {
    super("Mutation delivery is ambiguous and was not retried.");
    this.name = "AmbiguousMutationDeliveryError";
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
}

function retryAfterMs(value: string | null | undefined): number {
  if (!value) return MAX_RATE_LIMIT_WAIT_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RATE_LIMIT_WAIT_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return MAX_RATE_LIMIT_WAIT_MS;
  return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RATE_LIMIT_WAIT_MS);
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Request cancelled.");
  error.name = "AbortError";
  return error;
}

async function readBoundedResponse(
  response: Response,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    throw new EcobeeResponseLimitError(limitBytes);
  }

  if (!response.body) {
    const text =
      typeof response.text === "function"
        ? await response.text()
        : JSON.stringify(await response.json());
    if (Buffer.byteLength(text, "utf8") > limitBytes) {
      throw new EcobeeResponseLimitError(limitBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new EcobeeResponseLimitError(limitBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
