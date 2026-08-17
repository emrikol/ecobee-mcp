/**
 * TTL cache with in-flight request deduplication.
 * 60-second TTL per thermostat. Does not cache errors.
 */

import { activeSpan } from "../observability.js";

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class EcobeeCache {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get cached data or fetch it. Deduplicates in-flight requests for the same key.
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      recordCacheEvent("hit", key);
      return cached.data as T;
    }

    // Check if there's already an in-flight request
    const existing = this.inflight.get(key);
    if (existing) {
      recordCacheEvent("deduplicated", key);
      return existing as Promise<T>;
    }

    recordCacheEvent("miss", key);

    // Start new fetch with dedup
    const promise = fetcher()
      .then((data) => {
        this.cache.set(key, {
          data,
          expiresAt: Date.now() + this.ttlMs,
        });
        return data;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Invalidate all cache entries for a thermostat.
   * Called after write operations.
   */
  invalidate(thermostatId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${thermostatId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all cached data. */
  /* v8 ignore next 3 -- Integration test: cache full clear on server reset. */
  clear(): void {
    this.cache.clear();
  }
}

function recordCacheEvent(
  outcome: "hit" | "miss" | "deduplicated",
  key: string,
): void {
  const span = activeSpan();
  if (!span?.isRecording()) return;
  span.addEvent("ecobee.cache", {
    "ecobee.cache.outcome": outcome,
    "ecobee.cache.operation": key.slice(key.lastIndexOf(":") + 1).slice(0, 32),
  });
}
