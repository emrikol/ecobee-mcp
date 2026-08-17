import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime dependency boundary", () => {
  it("ships only the official MCP packages as direct runtime dependencies", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@modelcontextprotocol/node",
      "@modelcontextprotocol/server",
    ]);
  });
});
