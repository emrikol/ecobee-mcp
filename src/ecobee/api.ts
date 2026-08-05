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

/**
 * Ecobee REST API client with concurrency limiting.
 * Max 2 concurrent requests to avoid rate limiting.
 */
export class EcobeeApiClient {
  private activeRequests = 0;
  private readonly queue: Array<{
    resolve: () => void;
  }> = [];

  constructor(private readonly auth: EcobeeAuth) {}

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
  async getThermostats(
    selection: ThermostatSelection,
  ): Promise<Thermostat[]> {
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
  async setHvacMode(
    thermostatId: string,
    mode: string,
  ): Promise<void> {
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
  async deleteVacation(
    thermostatId: string,
    name: string,
  ): Promise<void> {
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
  async sendMessage(
    thermostatId: string,
    text: string,
  ): Promise<void> {
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
    return this.request<RuntimeReportResponse>(
      "GET",
      `/runtimeReport?${qs}`,
    );
  }

  /** Get all thermostat groups. */
  async getGroups(): Promise<Group[]> {
    const body = JSON.stringify({
      selection: { selectionType: "registered" },
    });
    const params = new URLSearchParams({ json: body });
    const resp = await this.request<GroupResponse>(
      "GET",
      `/group?${params}`,
    );
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
    await this.acquireSlot();
    try {
      return await this.doRequest<T>(method, path, body);
    } finally {
      this.releaseSlot();
    }
  }

  private async doRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    isRetry: boolean = false,
  ): Promise<T> {
    const token = await this.auth.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(`${ECOBEE_API_BASE}${path}`, {
      method,
      headers,
      ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !isRetry) {
      // Token may be expired - try to refresh and retry once
      await this.auth.handleUnauthorized();
      return this.doRequest<T>(method, path, body, true);
    }

    /* v8 ignore start -- Integration test: non-401 HTTP error from Ecobee API.
       Test with mock HTTP server returning 500/503 after a non-retry request. */
    if (!response.ok) {
      const text = await response.text();

      // An expired access token is reported as HTTP 500 with status.code 14,
      // not as a 401, so the check above never catches it. Without this the
      // server keeps using a stale in-memory token until it is restarted: in
      // readonly mode it never notices that the owning app already refreshed.
      if (!isRetry && parseEcobeeStatusCode(text) === ECOBEE_TOKEN_EXPIRED) {
        await this.auth.handleUnauthorized();
        return this.doRequest<T>(method, path, body, true);
      }

      throw new EcobeeApiError(
        `Ecobee API error: ${response.status} ${response.statusText} - ${text}`,
        response.status,
      );
    }
    /* v8 ignore stop */

    const data = await response.json();

    // Ecobee API returns status.code !== 0 for logical errors
    if (data?.status?.code !== undefined && data.status.code !== 0) {
      // Same expiry case, but returned alongside a 2xx status.
      if (!isRetry && data.status.code === ECOBEE_TOKEN_EXPIRED) {
        await this.auth.handleUnauthorized();
        return this.doRequest<T>(method, path, body, true);
      }

      throw new EcobeeApiError(
        `Ecobee API error: ${data.status.message} (code ${data.status.code})`,
        response.status,
        data.status.code,
      );
    }

    return data as T;
  }

  // --- Concurrency limiter ---

  private acquireSlot(): Promise<void> {
    if (this.activeRequests < MAX_CONCURRENT) {
      this.activeRequests++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
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
