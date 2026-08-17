import { describe, it, expect, vi, beforeEach } from "vitest";
import { EcobeeAuth } from "../../src/ecobee/auth.js";
import type { CredentialProvider } from "../../src/credentials/provider.js";
import type { EcobeeCredentials } from "../../src/ecobee/types.js";

function mockProvider(creds: EcobeeCredentials): CredentialProvider {
  return {
    getCredentials: vi.fn().mockResolvedValue(creds),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
  };
}

const validCreds: EcobeeCredentials = {
  accessToken: "access123",
  refreshToken: "refresh123",
  expiresAt: Date.now() + 3600_000,
  apiKey: "api-key",
};

describe("EcobeeAuth", () => {
  describe("readonly mode", () => {
    it("should return access token from provider", async () => {
      const provider = mockProvider(validCreds);
      const auth = new EcobeeAuth(provider, "readonly");

      const token = await auth.getAccessToken();
      expect(token).toBe("access123");
    });

    it("should re-read credentials on handleUnauthorized", async () => {
      const updatedCreds = { ...validCreds, accessToken: "new-token" };
      const provider: CredentialProvider = {
        getCredentials: vi
          .fn()
          .mockResolvedValueOnce(validCreds)
          .mockResolvedValueOnce(updatedCreds),
        saveCredentials: vi.fn(),
      };

      const auth = new EcobeeAuth(provider, "readonly");

      // First call loads initial creds
      await auth.getAccessToken();

      // Simulate 401 - should re-read
      const token = await auth.handleUnauthorized();
      expect(token).toBe("new-token");
      expect(provider.getCredentials).toHaveBeenCalledTimes(2);
    });

    it("should never attempt token refresh in readonly mode", async () => {
      const expiredCreds = { ...validCreds, expiresAt: Date.now() - 1000 };
      const provider = mockProvider(expiredCreds);

      const auth = new EcobeeAuth(provider, "readonly");

      // Should return expired token without trying to refresh
      const token = await auth.getAccessToken();
      expect(token).toBe("access123");
      expect(provider.saveCredentials).not.toHaveBeenCalled();
    });
  });

  describe("full mode", () => {
    let provider: CredentialProvider;

    beforeEach(() => {
      // Mock fetch for token refresh
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "refreshed-token",
              refresh_token: "new-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "smartWrite",
            }),
        }),
      );

      provider = {
        getCredentials: vi.fn().mockResolvedValue(validCreds),
        saveCredentials: vi.fn().mockResolvedValue(undefined),
      };
    });

    it("should proactively refresh before expiry", async () => {
      const almostExpired = {
        ...validCreds,
        expiresAt: Date.now() + 60_000, // 1 min left (< 5 min margin)
      };
      provider.getCredentials = vi.fn().mockResolvedValue(almostExpired);

      const auth = new EcobeeAuth(provider, "full");

      const token = await auth.getAccessToken();
      expect(token).toBe("refreshed-token");
      expect(provider.saveCredentials).toHaveBeenCalled();
    });

    it("should deduplicate concurrent refresh attempts", async () => {
      const almostExpired = {
        ...validCreds,
        expiresAt: Date.now() + 60_000,
      };
      provider.getCredentials = vi.fn().mockResolvedValue(almostExpired);

      const auth = new EcobeeAuth(provider, "full");

      // Two concurrent getAccessToken calls
      const [t1, t2] = await Promise.all([
        auth.getAccessToken(),
        auth.getAccessToken(),
      ]);

      expect(t1).toBe("refreshed-token");
      expect(t2).toBe("refreshed-token");
      // fetch should only be called once (dedup)
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("should call onTokenRefresh hooks after refresh", async () => {
      const almostExpired = {
        ...validCreds,
        expiresAt: Date.now() + 60_000,
      };
      provider.getCredentials = vi.fn().mockResolvedValue(almostExpired);

      const auth = new EcobeeAuth(provider, "full");
      const hook = vi.fn().mockResolvedValue(undefined);
      auth.addTokenRefreshHook(hook);

      await auth.getAccessToken();

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "refreshed-token",
          refreshToken: "new-refresh",
        }),
      );
    });

    it("does not expose secrets from a failed token refresh", async () => {
      const almostExpired = {
        ...validCreds,
        refreshToken: "refresh-token-never-expose",
        apiKey: "client-key-never-expose",
        expiresAt: Date.now() + 60_000,
      };
      provider.getCredentials = vi.fn().mockResolvedValue(almostExpired);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              "refresh_token=refresh-token-never-expose&client_id=client-key-never-expose",
            ),
        }),
      );
      const auth = new EcobeeAuth(provider, "full");

      let caught: unknown;
      try {
        await auth.getAccessToken();
      } catch (error) {
        caught = error;
      }

      expect(String(caught)).toContain("HTTP 400");
      expect(String(caught)).not.toContain("refresh-token-never-expose");
      expect(String(caught)).not.toContain("client-key-never-expose");
      expect(provider.saveCredentials).not.toHaveBeenCalled();
    });

    it("isolates token refresh hook failures without logging credentials", async () => {
      const almostExpired = {
        ...validCreds,
        expiresAt: Date.now() + 60_000,
      };
      provider.getCredentials = vi.fn().mockResolvedValue(almostExpired);
      const auth = new EcobeeAuth(provider, "full");
      auth.addTokenRefreshHook(async (credentials) => {
        throw new Error(`access_token=${credentials.accessToken}`);
      });
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await expect(auth.getAccessToken()).resolves.toBe("refreshed-token");
      expect(errorLog).toHaveBeenCalledWith("[auth] Token refresh hook failed");
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "refreshed-token",
      );
    });
  });
});
