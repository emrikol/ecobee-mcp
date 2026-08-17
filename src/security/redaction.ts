const SECRET_ASSIGNMENT =
  /(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)\s*[:=]\s*["']?[^\s,"'}]+/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,"'}]+/gi;
const SECRET_JSON =
  /("(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)"\s*:\s*")[^"]*(")/gi;
const SECRET_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)$/i;
const MAY_CONTAIN_SECRET =
  /(?:\bBearer\s|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|\bpin\b)/i;

/**
 * Defense-in-depth redaction for diagnostics. Model-visible failures use fixed,
 * typed messages instead of passing remote error bodies through this helper.
 */
export function redactSecrets(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  if (!MAY_CONTAIN_SECRET.test(text)) return text;
  return text
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(SECRET_JSON, "$1[REDACTED]$2");
}

export function safeDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`);
  }
  return "Unknown error";
}

/** Recursively remove secret-bearing fields before data becomes model-visible. */
export function redactStructuredSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) {
    let redacted: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const child = value[index];
      const next = redactStructuredSecrets(child);
      if (next !== child) {
        redacted ??= value.slice();
        redacted[index] = next;
      }
    }
    return redacted ?? value;
  }
  if (typeof value !== "object" || value === null) return value;

  let redacted: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value)) {
    const next = SECRET_KEY.test(key)
      ? "[REDACTED]"
      : redactStructuredSecrets(child);
    if (next !== child) {
      redacted ??= { ...value };
      redacted[key] = next;
    }
  }
  return redacted ?? value;
}
