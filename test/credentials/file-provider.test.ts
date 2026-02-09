import { describe, it, expect, afterEach } from "vitest";
import { readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCredentialProvider } from "../../src/credentials/file-provider.js";
import type { EcobeeCredentials } from "../../src/ecobee/types.js";
import { writeFile } from "node:fs/promises";

const tmpFile = join(tmpdir(), `ecobee-test-creds-${process.pid}.json`);

afterEach(async () => {
  try {
    await unlink(tmpFile);
  } catch {
    // Ignore if doesn't exist
  }
});

describe("FileCredentialProvider", () => {
  const validCreds: EcobeeCredentials = {
    accessToken: "access123",
    refreshToken: "refresh123",
    expiresAt: 1700000000000,
    apiKey: "api-key-123",
  };

  it("should read credentials from file", async () => {
    await writeFile(tmpFile, JSON.stringify(validCreds));

    const provider = new FileCredentialProvider(tmpFile);
    const creds = await provider.getCredentials();

    expect(creds.accessToken).toBe("access123");
    expect(creds.refreshToken).toBe("refresh123");
    expect(creds.apiKey).toBe("api-key-123");
  });

  it("should throw on missing required fields", async () => {
    await writeFile(tmpFile, JSON.stringify({ accessToken: "test" }));

    const provider = new FileCredentialProvider(tmpFile);
    await expect(provider.getCredentials()).rejects.toThrow(
      "missing required fields",
    );
  });

  it("should write credentials atomically", async () => {
    const provider = new FileCredentialProvider(tmpFile);
    await provider.saveCredentials(validCreds);

    const data = JSON.parse(await readFile(tmpFile, "utf-8"));
    expect(data.accessToken).toBe("access123");
    expect(data.refreshToken).toBe("refresh123");
  });

  it("should set restrictive file permissions", async () => {
    const provider = new FileCredentialProvider(tmpFile);
    await provider.saveCredentials(validCreds);

    const stats = await stat(tmpFile);
    // 0o600 = owner rw only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("should throw on non-existent file", async () => {
    const provider = new FileCredentialProvider("/tmp/does-not-exist.json");
    await expect(provider.getCredentials()).rejects.toThrow();
  });
});
