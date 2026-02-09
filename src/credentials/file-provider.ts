import { readFile, rename, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { EcobeeCredentials } from "../ecobee/types.js";
import type { CredentialProvider } from "./provider.js";

/**
 * Default credential provider that reads/writes a JSON file.
 * Uses atomic writes (write tmp → fsync → rename) and 0600 permissions.
 */
export class FileCredentialProvider implements CredentialProvider {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = /* v8 ignore next */
      filePath ?? join(process.cwd(), "credentials.json");
  }

  async getCredentials(): Promise<EcobeeCredentials> {
    const data = await readFile(this.filePath, "utf-8");
    const parsed = JSON.parse(data);

    if (
      !parsed.accessToken ||
      !parsed.refreshToken ||
      !parsed.apiKey
    ) {
      throw new Error(
        `Invalid credentials file: missing required fields in ${this.filePath}`,
      );
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt ?? 0, /* v8 ignore next */
      apiKey: parsed.apiKey,
    };
  }

  async saveCredentials(creds: EcobeeCredentials): Promise<void> {
    const tmpPath = join(
      dirname(this.filePath),
      `.credentials.tmp.${process.pid}`,
    );
    const data = JSON.stringify(creds, null, 2) + "\n";

    // Atomic write: write tmp → fsync → rename
    const fd = await open(tmpPath, "w", 0o600);
    try {
      await fd.writeFile(data);
      await fd.sync();
    } finally {
      await fd.close();
    }

    await rename(tmpPath, this.filePath);
  }
}
