import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadPlugins } from "../../src/plugins/loader.js";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadPlugins", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ecobee-plugin-test-"));
    await mkdir(join(tmpDir, "plugins"));
  });

  afterEach(async () => {
    delete process.env.ENABLE_PLUGINS;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty when ENABLE_PLUGINS is not set", async () => {
    delete process.env.ENABLE_PLUGINS;
    const plugins = await loadPlugins(tmpDir);
    expect(plugins).toEqual([]);
  });

  it("should load valid .js plugins", async () => {
    process.env.ENABLE_PLUGINS = "1";

    const pluginCode = `
      export default {
        name: "test-plugin",
      };
    `;
    await writeFile(join(tmpDir, "plugins", "test.js"), pluginCode);

    const plugins = await loadPlugins(tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("test-plugin");

    delete process.env.ENABLE_PLUGINS;
  });

  it("rejects the complete candidate when a plugin is malformed", async () => {
    process.env.ENABLE_PLUGINS = "1";

    // Missing name field
    await writeFile(
      join(tmpDir, "plugins", "bad.js"),
      "export default { notAPlugin: true };",
    );

    await expect(loadPlugins(tmpDir)).rejects.toThrow(
      "Plugin candidate bad.js failed to load.",
    );
  });

  it("cache-busts changed modules at the explicit load boundary", async () => {
    process.env.ENABLE_PLUGINS = "1";
    const pluginPath = join(tmpDir, "plugins", "reloadable.js");
    await writeFile(pluginPath, 'export default { name: "version-one" };');
    expect((await loadPlugins(tmpDir))[0].name).toBe("version-one");

    await writeFile(pluginPath, 'export default { name: "version-two" };');
    expect((await loadPlugins(tmpDir))[0].name).toBe("version-two");
  });

  it("should only load .js files, not .ts", async () => {
    process.env.ENABLE_PLUGINS = "1";

    await writeFile(
      join(tmpDir, "plugins", "valid.js"),
      'export default { name: "js-plugin" };',
    );
    await writeFile(
      join(tmpDir, "plugins", "ignore.ts"),
      'export default { name: "ts-plugin" };',
    );

    const plugins = await loadPlugins(tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("js-plugin");

    delete process.env.ENABLE_PLUGINS;
  });

  it("should let first plugin with credentialProvider win", async () => {
    process.env.ENABLE_PLUGINS = "1";

    await writeFile(
      join(tmpDir, "plugins", "a-first.js"),
      `export default {
        name: "plugin-a",
        credentialProvider: { getCredentials: async () => ({}), saveCredentials: async () => {} }
      };`,
    );
    await writeFile(
      join(tmpDir, "plugins", "b-second.js"),
      `export default {
        name: "plugin-b",
        credentialProvider: { getCredentials: async () => ({}), saveCredentials: async () => {} }
      };`,
    );

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const plugins = await loadPlugins(tmpDir);
    expect(plugins).toHaveLength(2);
    // First one should keep its provider
    expect(plugins[0].credentialProvider).toBeDefined();
    // Second one should have it cleared
    expect(plugins[1].credentialProvider).toBeUndefined();

    consoleSpy.mockRestore();
    delete process.env.ENABLE_PLUGINS;
  });

  it("should reject symlinks escaping plugin directory", async () => {
    process.env.ENABLE_PLUGINS = "1";

    const outsideFile = join(tmpDir, "outside.js");
    await writeFile(outsideFile, 'export default { name: "escape-attempt" };');
    await symlink(outsideFile, join(tmpDir, "plugins", "escape.js"));

    await expect(loadPlugins(tmpDir)).rejects.toThrow(
      "Plugin path escapes the plugin directory.",
    );
  });
});
