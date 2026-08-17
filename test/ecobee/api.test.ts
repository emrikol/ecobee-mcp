import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AmbiguousMutationDeliveryError,
  EcobeeApiClient,
  EcobeeApiError,
  EcobeeRateLimitError,
  EcobeeResponseLimitError,
  EcobeeTimeoutError,
} from "../../src/ecobee/api.js";
import type { EcobeeAuth } from "../../src/ecobee/auth.js";

function mockAuth(): EcobeeAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue("test-token"),
    handleUnauthorized: vi.fn().mockResolvedValue("refreshed-token"),
  } as unknown as EcobeeAuth;
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

describe("EcobeeApiClient", () => {
  let auth: EcobeeAuth;

  beforeEach(() => {
    auth = mockAuth();
  });

  it("should get thermostats with correct headers", async () => {
    const fetchMock = mockFetchResponse({
      status: { code: 0, message: "Success" },
      thermostatList: [{ identifier: "123", name: "Main" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    const result = await api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
      includeRuntime: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe("123");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/thermostat?"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("should retry on 401 with refreshed token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("Unauthorized"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            status: { code: 0, message: "Success" },
            thermostatList: [{ identifier: "123", name: "Main" }],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    const result = await api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
    });

    expect(result).toHaveLength(1);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should throw EcobeeApiError on Ecobee status code != 0", async () => {
    const fetchMock = mockFetchResponse({
      status: { code: 14, message: "Not authorized" },
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    await expect(
      api.getThermostats({
        selectionType: "registered",
        selectionMatch: "",
      }),
    ).rejects.toThrow(EcobeeApiError);
  });

  it("should limit concurrency to 2", async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;

    const fetchMock = vi.fn().mockImplementation(async () => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((r) => setTimeout(r, 50));
      activeCalls--;
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            status: { code: 0, message: "Success" },
            thermostatList: [],
          }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);

    // Fire 4 concurrent requests
    await Promise.all([
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("re-reads credentials when an expired token is reported as HTTP 500 code 14", async () => {
    // Ecobee signals an expired access token with HTTP 500 and status.code 14,
    // not a 401. Before this was handled the request threw and the server kept
    // its stale in-memory token until restarted.
    const expired = {
      status: {
        code: 14,
        message: "Authentication token has expired. Refresh your tokens. ",
      },
    };
    const success = {
      status: { code: 0, message: "Success" },
      thermostatList: [{ identifier: "123", name: "Main" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve(expired),
        text: () => Promise.resolve(JSON.stringify(expired)),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(success),
        text: () => Promise.resolve(JSON.stringify(success)),
      });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    const result = await api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
    });

    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result[0].identifier).toBe("123");
  });

  it("re-reads credentials when code 14 arrives alongside a 2xx status", async () => {
    const expired = {
      status: {
        code: 14,
        message: "Authentication token has expired. Refresh your tokens. ",
      },
    };
    const success = {
      status: { code: 0, message: "Success" },
      thermostatList: [{ identifier: "456", name: "Cabin" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(expired),
        text: () => Promise.resolve(JSON.stringify(expired)),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(success),
        text: () => Promise.resolve(JSON.stringify(success)),
      });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    const result = await api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
    });

    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(result[0].identifier).toBe("456");
  });

  it("retries an expired token only once", async () => {
    const expired = {
      status: {
        code: 14,
        message: "Authentication token has expired. Refresh your tokens. ",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve(expired),
      text: () => Promise.resolve(JSON.stringify(expired)),
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    await expect(
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
    ).rejects.toThrow(EcobeeApiError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not treat a non-auth error body as an expired token", async () => {
    const validation = {
      status: { code: 7, message: "Validation error." },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve(validation),
      text: () => Promise.resolve(JSON.stringify(validation)),
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    await expect(
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
    ).rejects.toThrow(EcobeeApiError);

    expect(auth.handleUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw parsing a non-JSON error body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("<html>upstream error</html>"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new EcobeeApiClient(auth);
    await expect(
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
    ).rejects.toThrow(EcobeeApiError);

    expect(auth.handleUnauthorized).not.toHaveBeenCalled();
  });

  it("enforces a request deadline across Ecobee I/O", async () => {
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const api = new EcobeeApiClient(auth, {
      fetch: fetchMock as typeof fetch,
      requestTimeoutMs: 10,
    });

    await expect(
      api.getThermostats({
        selectionType: "registered",
        selectionMatch: "",
      }),
    ).rejects.toBeInstanceOf(EcobeeTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates request cancellation into Ecobee fetch", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestStarted();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const api = new EcobeeApiClient(auth, { fetch: fetchMock as typeof fetch });
    const controller = new AbortController();
    const request = api.withRequestSignal(controller.signal, () =>
      api.getThermostats({ selectionType: "registered", selectionMatch: "" }),
    );

    await started;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited read once with a bounded delay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: { code: 0, message: "Success" },
            thermostatList: [{ identifier: "123", name: "Main" }],
          }),
          { status: 200 },
        ),
      );
    const api = new EcobeeApiClient(auth, { fetch: fetchMock as typeof fetch });

    const result = await api.getThermostats({
      selectionType: "registered",
      selectionMatch: "",
    });

    expect(result[0].identifier).toBe("123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a rate-limited mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );
    const api = new EcobeeApiClient(auth, { fetch: fetchMock as typeof fetch });

    await expect(api.sendMessage("123", "hello")).rejects.toBeInstanceOf(
      EcobeeRateLimitError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses larger than the configured limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("x".repeat(65), {
        status: 200,
        headers: { "content-length": "65" },
      }),
    );
    const api = new EcobeeApiClient(auth, {
      fetch: fetchMock as typeof fetch,
      maxResponseBytes: 64,
    });

    await expect(
      api.getThermostats({
        selectionType: "registered",
        selectionMatch: "",
      }),
    ).rejects.toBeInstanceOf(EcobeeResponseLimitError);
  });

  it("marks ambiguous mutation delivery and does not retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new Error("socket reset after write access_token=never-expose"),
      );
    const api = new EcobeeApiClient(auth, { fetch: fetchMock as typeof fetch });

    let caught: unknown;
    try {
      await api.sendMessage("123", "hello");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AmbiguousMutationDeliveryError);
    expect(String(caught)).not.toContain("never-expose");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an invalid success response after a mutation as ambiguous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not-json", { status: 200 }));
    const api = new EcobeeApiClient(auth, {
      fetch: fetchMock as typeof fetch,
    });

    await expect(api.sendMessage("123", "hello")).rejects.toBeInstanceOf(
      AmbiguousMutationDeliveryError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose an Ecobee error body containing secrets", async () => {
    const body = {
      status: {
        code: 7,
        message: "refresh_token=refresh-secret authorization_code=code-secret",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 400,
      }),
    );
    const api = new EcobeeApiClient(auth, { fetch: fetchMock as typeof fetch });

    let caught: unknown;
    try {
      await api.getThermostats({
        selectionType: "registered",
        selectionMatch: "",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EcobeeApiError);
    expect(String(caught)).not.toContain("refresh-secret");
    expect(String(caught)).not.toContain("code-secret");
  });
});
