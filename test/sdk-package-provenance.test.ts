import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PACKAGES = {
  "modelcontextprotocol-core-2.0.0-mod-perf-b7608a8.tgz":
    "fb665bac2c7a1114a2ef7eaaaabaaa57af3023a93ace823e7b2fb5cda2f90b3b",
  "modelcontextprotocol-node-2.0.0-mod-perf-b7608a8.tgz":
    "35876c6fffb1840b3b819684952de34bcc267f4e553b594d083da1621dff5337",
  "modelcontextprotocol-server-2.0.0-mod-perf-b7608a8.tgz":
    "e4801adf15c4218418732c31f1788b7f3fc7bf9aacdff2bba2cf33c31f55a1a7",
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
