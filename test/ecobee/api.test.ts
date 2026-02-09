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
});
