import { describe, expect, it } from "vitest";
import {
  redactSecrets,
  redactStructuredSecrets,
  safeDiagnostic,
} from "../../src/security/redaction.js";

describe("secret redaction", () => {
  it("redacts every credential class from diagnostics", () => {
    const diagnostic = redactSecrets(
      "Bearer bearer-secret access_token=access-secret " +
        "refresh-token:refresh-secret client_secret=client-secret " +
        "authorization_code=code-secret api_key=key-secret ecobee_pin=pin-secret",
    );

    for (const secret of [
      "bearer-secret",
      "access-secret",
      "refresh-secret",
      "client-secret",
      "code-secret",
      "key-secret",
      "pin-secret",
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
  });

  it("never stringifies non-error diagnostic objects", () => {
    expect(safeDiagnostic({ refreshToken: "refresh-secret" })).toBe(
      "Unknown error",
    );
  });

  it("redacts snake-case JSON credentials", () => {
    const diagnostic = redactSecrets(
      '{"access_token":"access-secret","refresh_token":"refresh-secret","ecobee_pin":"pin-secret"}',
    );
    expect(diagnostic).not.toContain("access-secret");
    expect(diagnostic).not.toContain("refresh-secret");
    expect(diagnostic).not.toContain("pin-secret");
  });

  it("redacts secret fields in structured output", () => {
    const sanitized = redactStructuredSecrets({
      nested: {
        accessToken: "access-secret",
        refresh_token: "refresh-secret",
      },
      safe: "visible",
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).toContain("visible");
  });
});
