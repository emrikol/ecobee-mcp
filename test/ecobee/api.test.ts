import { describe, it, expect, vi, beforeEach } from "vitest";
import { EcobeeApiClient, EcobeeApiError } from "../../src/ecobee/api.js";
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
      status: { code: 14, message: "Authentication token has expired. Refresh your tokens. " },
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
      status: { code: 14, message: "Authentication token has expired. Refresh your tokens. " },
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
      status: { code: 14, message: "Authentication token has expired. Refresh your tokens. " },
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
});