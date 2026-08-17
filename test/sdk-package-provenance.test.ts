import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PACKAGES = {
  "modelcontextprotocol-core-2.0.0-mod-perf-346fdcc.tgz":
    "f3f5066ce5dbf2e1b58a55abd3a5a447b276a8f5d3b0355bab89c49ed5a9c6a8",
  "modelcontextprotocol-node-2.0.0-mod-perf-346fdcc.tgz":
    "d602f1991c3461eb9cb0000be245d8c8de0813d04a931d8ec9afd7dc098f9372",
  "modelcontextprotocol-server-2.0.0-mod-perf-346fdcc.tgz":
    "760b93a44f84a92c2d5227781392191b89cb399c9c92a2c98237be3c4f81b6bb",
} as const;

describe("pinned MCP SDK packages", () => {
  it("matches the reviewed performance-fork build", async () => {
    for (const [filename, expectedHash] of Object.entries(PACKAGES)) {
      const bytes = await readFile(
        new URL(`../vendor/${filename}`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        expectedHash,
      );
    }
  });
});
