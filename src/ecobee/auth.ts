import type { CredentialProvider } from "../credentials/provider.js";
import type {
  EcobeeCredentials,
  EcobeeTokenResponse,
} from "./types.js";

export type AuthMode = "readonly" | "full";

const ECOBEE_TOKEN_URL = "https://api.ecobee.com/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * Manages Ecobee OAuth tokens.
 *
 * - **readonly mode**: Reads tokens from credential provider. On 401, re-reads
 *   credentials (another app may have refreshed). Never refreshes tokens itself.
 * - **full mode**: Manages token lifecycle, proactively refreshes before expiry,
 *   deduplicates concurrent refresh attempts.
 */
export class EcobeeAuth {
  private credentials: EcobeeCredentials | null = null;
  private refreshPromise: Promise<EcobeeCredentials> | null = null;
  private readonly onTokenRefreshHooks: Array<
    (creds: EcobeeCredentials) => Promise<void>
  > = [];

  constructor(
    private readonly provider: CredentialProvider,
    private readonly mode: AuthMode = "readonly",
  ) {}

  /** Register a hook to be called after token refresh (full mode only). */
  addTokenRefreshHook(
    hook: (creds: EcobeeCredentials) => Promise<void>,
  ): void {
    this.onTokenRefreshHooks.push(hook);
  }

  /** Get a valid access token, refreshing if needed. */
  async getAccessToken(): Promise<string> {
    if (!this.credentials) {
      this.credentials = await this.provider.getCredentials();
    }

    if (this.mode === "full" && this.isExpiringSoon()) {
      this.credentials = await this.refresh();
    }

    return this.credentials.accessToken;
  }

  /**
   * Handle a 401 response from the Ecobee API.
   * - readonly mode: re-reads credentials from provider
   * - full mode: forces a token refresh
   */
  async handleUnauthorized(): Promise<string> {
    if (this.mode === "readonly") {
      // Another app may have refreshed - re-read from provider
      this.credentials = await this.provider.getCredentials();
      return this.credentials.accessToken;
    }

    /* v8 ignore start -- Integration test: full-mode force refresh on 401.
       Test with mock Ecobee token endpoint and an EcobeeApiClient that gets 401. */
    // Full mode: force refresh
    this.credentials = null;
    this.credentials = await this.refresh();
    return this.credentials.accessToken;
    /* v8 ignore stop */
  }

  private isExpiringSoon(): boolean {
    if (!this.credentials) return true;
    return Date.now() + REFRESH_MARGIN_MS >= this.credentials.expiresAt;
  }

  /** Refresh token with deduplication of concurrent attempts. */
  private async refresh(): Promise<EcobeeCredentials> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /* v8 ignore start -- Integration test: OAuth token refresh via HTTP.
     Test with mock Ecobee token endpoint. Verify: refresh_token grant,
     credential persistence after refresh, hook notification, HTTP error
     handling (non-ok response), and hook error isolation. */
  private async doRefresh(): Promise<EcobeeCredentials> {
    const current = this.credentials ?? (await this.provider.getCredentials());

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.apiKey,
    });

    const response = await fetch(ECOBEE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText} - ${body}`,
      );
    }

    const tokenData: EcobeeTokenResponse = await response.json();

    const newCreds: EcobeeCredentials = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      apiKey: current.apiKey,
    };

    // Persist new credentials
    await this.provider.saveCredentials(newCreds);

    // Notify hooks
    for (const hook of this.onTokenRefreshHooks) {
      try {
        await hook(newCreds);
      } catch (err) {
        console.error("[auth] Token refresh hook error:", err);
      }
    }

    return newCreds;
  }
  /* v8 ignore stop */
}
