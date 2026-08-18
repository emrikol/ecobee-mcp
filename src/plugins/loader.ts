import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EcobeePlugin } from "./types.js";

const PLUGIN_DIR = "plugins";

/**
 * Validates that an object matches the EcobeePlugin interface shape.
 */
function isValidPlugin(obj: unknown): obj is EcobeePlugin {
  if (typeof obj !== "object" || obj === null) return false;
  const candidate = obj as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0)
    return false;

  // Optional fields type checks
  /* v8 ignore start -- Integration test: plugin validation with malformed exports.
     Test by placing .js files with wrong-typed fields in plugins/ directory. */
  if (
    candidate.credentialProvider !== undefined &&
    typeof candidate.credentialProvider !== "object"
  )
    return false;
  if (
    candidate.onTokenRefresh !== undefined &&
    typeof candidate.onTokenRefresh !== "function"
  )
    return false;
  if (
    candidate.registerTools !== undefined &&
    typeof candidate.registerTools !== "function"
  )
    return false;
  if (
    candidate.registerResources !== undefined &&
    typeof candidate.registerResources !== "function"
  )
    return false;
  /* v8 ignore stop */

  return true;
}

/**
 * Loads plugins from the plugins/ directory.
 * Only enabled when ENABLE_PLUGINS=1 env var is set.
 * Returns one complete, deterministic candidate set. A malformed plugin
 * rejects the entire load so a caller can retain its last-good catalog.
 * The first plugin with a credentialProvider wins at process startup.
 */
export async function loadPlugins(baseDir?: string): Promise<EcobeePlugin[]> {
  if (process.env.ENABLE_PLUGINS !== "1") {
    return [];
  }

  const pluginDir = resolve(baseDir ?? process.cwd(), PLUGIN_DIR);
  const resolvedPluginDir = await realpath(pluginDir).catch(() => pluginDir);

  let entries: string[];
  try {
    const files = await readdir(pluginDir);
    entries = files.filter((f) => extname(f) === ".js").sort();
  } catch /* v8 ignore start -- Integration test: plugins dir doesn't exist on filesystem. */ {
    console.log(`[plugins] No plugins directory found at ${pluginDir}`);
    return [];
  } /* v8 ignore stop */

  /* v8 ignore next 4 -- Integration test: plugins dir exists but contains no .js files. */
  if (entries.length === 0) {
    console.log("[plugins] No .js plugins found");
    return [];
  }

  const plugins: EcobeePlugin[] = [];
  const pluginNames = new Set<string>();
  let credentialProviderOwner: string | null = null;

  for (const filename of entries) {
    const fullPath = join(pluginDir, filename);

    // Symlink protection: resolved path must stay inside plugin dir
    const resolvedPath = await realpath(fullPath);
    const relativePath = relative(resolvedPluginDir, resolvedPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Plugin path escapes the plugin directory.");
    }

    try {
      const source = await readFile(resolvedPath);
      const digest = createHash("sha256").update(source).digest("hex");
      const fileUrl = `${pathToFileURL(resolvedPath).href}?catalog=${digest}`;
      const mod = await import(fileUrl);
      const plugin = mod.default ?? mod;

      if (!isValidPlugin(plugin)) {
        throw new Error("Plugin does not match the EcobeePlugin interface.");
      }
      if (pluginNames.has(plugin.name)) {
        throw new Error("Duplicate plugin name.");
      }
      pluginNames.add(plugin.name);

      const loadedPlugin: EcobeePlugin = { ...plugin };

      if (loadedPlugin.credentialProvider) {
        if (credentialProviderOwner) {
          console.warn("[plugins] Ignoring duplicate credential provider");
          loadedPlugin.credentialProvider = undefined;
        } else {
          credentialProviderOwner = filename;
          console.log("[plugins] Registered credential provider");
        }
      }

      plugins.push(loadedPlugin);
      console.log("[plugins] Loaded plugin");
    } catch {
      throw new Error(`Plugin candidate ${filename} failed to load.`);
    }
  }

  return plugins;
}
