import { readdir, realpath } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
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
 * Returns loaded plugins; first plugin with credentialProvider wins.
 */
export async function loadPlugins(
  baseDir?: string,
): Promise<EcobeePlugin[]> {
  if (process.env.ENABLE_PLUGINS !== "1") {
    return [];
  }

  const pluginDir = resolve(baseDir ?? process.cwd(), PLUGIN_DIR);
  const resolvedPluginDir = await realpath(pluginDir).catch(() => pluginDir);

  let entries: string[];
  try {
    const files = await readdir(pluginDir);
    entries = files.filter((f) => extname(f) === ".js");
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
  let credentialProviderOwner: string | null = null;

  for (const filename of entries) {
    const fullPath = join(pluginDir, filename);

    // Symlink protection: resolved path must stay inside plugin dir
    const resolvedPath = await realpath(fullPath);
    if (!resolvedPath.startsWith(resolvedPluginDir)) {
      console.warn(
        `[plugins] Skipping ${filename}: resolved path ${resolvedPath} escapes plugin directory`,
      );
      continue;
    }

    try {
      const fileUrl = pathToFileURL(resolvedPath).href;
      const mod = await import(fileUrl);
      const plugin = mod.default ?? mod;

      if (!isValidPlugin(plugin)) {
        console.warn(
          `[plugins] Skipping ${filename}: does not match EcobeePlugin interface`,
        );
        continue;
      }

      if (plugin.credentialProvider) {
        if (credentialProviderOwner) {
          console.warn(
            `[plugins] ${filename} provides credentialProvider, but ${credentialProviderOwner} already registered one. Ignoring.`,
          );
          plugin.credentialProvider = undefined;
        } else {
          credentialProviderOwner = filename;
          console.log(
            `[plugins] ${filename} registered as credential provider`,
          );
        }
      }

      plugins.push(plugin);
      console.log(`[plugins] Loaded: ${plugin.name} (${filename})`);
    } catch (err) /* v8 ignore start -- Integration test: malformed/unloadable plugin .js file. */ {
      console.error(`[plugins] Failed to load ${filename}:`, err);
    } /* v8 ignore stop */
  }

  return plugins;
}
