const SECRET_ASSIGNMENT =
  /(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)\s*[:=]\s*["']?[^\s,"'}]+/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,"'}]+/gi;
const SECRET_JSON =
  /("(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)"\s*:\s*")[^"]*(")/gi;
const SECRET_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|api[_-]?key|ecobee[_-]?pin|pin)$/i;

/**
 * Defense-in-depth redaction for diagnostics. Model-visible failures use fixed,
 * typed messages instead of passing remote error bodies through this helper.
 */
export function redactSecrets(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
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
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactStructuredSecrets(child),
    ]),
  );
}
