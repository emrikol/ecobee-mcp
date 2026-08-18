import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime dependency boundary", () => {
  it("ships only MCP SDK packages as direct runtime dependencies", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@modelcontextprotocol/core",
      "@modelcontextprotocol/node",
      "@modelcontextprotocol/server",
    ]);
    for (const specifier of Object.values(packageJson.dependencies ?? {})) {
      expect(specifier).toMatch(
        /^file:vendor\/modelcontextprotocol-(?:core|node|server)-2\.0\.0-mod-perf-b7608a8\.tgz$/,
      );
    }
  });
});
