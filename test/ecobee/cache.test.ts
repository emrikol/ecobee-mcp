import { describe, it, expect, vi, beforeEach } from "vitest";
import { EcobeeCache } from "../../src/ecobee/cache.js";

describe("EcobeeCache", () => {
  let cache: EcobeeCache;

  beforeEach(() => {
    cache = new EcobeeCache(100); // 100ms TTL for tests
  });

  it("should return cached data within TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue({ temp: 72 });

    const result1 = await cache.getOrFetch("t1:status", fetcher);
    const result2 = await cache.getOrFetch("t1:status", fetcher);

    expect(result1).toEqual({ temp: 72 });
    expect(result2).toEqual({ temp: 72 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("should re-fetch after TTL expires", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ temp: 72 })
      .mockResolvedValueOnce({ temp: 74 });

    const result1 = await cache.getOrFetch("t1:status", fetcher);
    expect(result1).toEqual({ temp: 72 });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    const result2 = await cache.getOrFetch("t1:status", fetcher);
    expect(result2).toEqual({ temp: 74 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("should deduplicate in-flight requests", async () => {
    let resolveIt: (v: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveIt = resolve;
      }),
    );

    const p1 = cache.getOrFetch("t1:status", fetcher);
    const p2 = cache.getOrFetch("t1:status", fetcher);

    // Only one fetch should have started
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveIt!({ temp: 72 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ temp: 72 });
    expect(r2).toEqual({ temp: 72 });
  });

  it("should invalidate all entries for a thermostat", async () => {
    const fetcher1 = vi.fn().mockResolvedValue("status");
    const fetcher2 = vi.fn().mockResolvedValue("sensors");
    const fetcher3 = vi.fn().mockResolvedValue("other");

    await cache.getOrFetch("t1:status", fetcher1);
    await cache.getOrFetch("t1:sensors", fetcher2);
    await cache.getOrFetch("t2:status", fetcher3);

    cache.invalidate("t1");

    // t1 entries should be re-fetched
    await cache.getOrFetch("t1:status", fetcher1);
    await cache.getOrFetch("t1:sensors", fetcher2);
    // t2 should still be cached
    await cache.getOrFetch("t2:status", fetcher3);

    expect(fetcher1).toHaveBeenCalledTimes(2);
    expect(fetcher2).toHaveBeenCalledTimes(2);
    expect(fetcher3).toHaveBeenCalledTimes(1);
  });

  it("should not cache errors", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ temp: 72 });

    await expect(cache.getOrFetch("t1:status", fetcher)).rejects.toThrow(
      "fail",
    );

    const result = await cache.getOrFetch("t1:status", fetcher);
    expect(result).toEqual({ temp: 72 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
