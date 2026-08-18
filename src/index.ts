import { pathToFileURL } from "node:url";
import { EcobeeAuth } from "./ecobee/auth.js";
import { EcobeeApiClient } from "./ecobee/api.js";
import { EcobeeCache } from "./ecobee/cache.js";
import { FileCredentialProvider } from "./credentials/file-provider.js";
import { createHttpService } from "./http.js";
import { loadPlugins } from "./plugins/loader.js";
import type { CredentialProvider } from "./credentials/provider.js";
import type { AuthMode } from "./ecobee/auth.js";

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const authToken = process.env.MCP_AUTH_TOKEN;
  const credentialsPath = process.env.CREDENTIALS_PATH;
  const authMode = parseAuthMode(process.env.AUTH_MODE);
  const performanceCaches = process.env.MCP_PERFORMANCE_CACHES !== "0";
  const pluginsEnabled = process.env.ENABLE_PLUGINS === "1";
  const plugins = await loadPlugins();

  let credentialProvider: CredentialProvider = new FileCredentialProvider(
    credentialsPath,
  );
  const pluginWithCredentials = plugins.find(
    (plugin) => plugin.credentialProvider,
  );
  if (pluginWithCredentials?.credentialProvider) {
    credentialProvider = pluginWithCredentials.credentialProvider;
    console.log("[main] Using plugin credential provider");
  }

  const auth = new EcobeeAuth(credentialProvider, authMode);
  const api = new EcobeeApiClient(auth);
  const cache = new EcobeeCache();
  for (const plugin of plugins) {
    if (plugin.onTokenRefresh) auth.addTokenRefreshHook(plugin.onTokenRefresh);
  }

  const service = await createHttpService({
    api,
    cache,
    plugins,
    catalogLoader: pluginsEnabled ? () => loadPlugins() : undefined,
    authToken,
    performanceCaches,
  });
  const listener = service.app.listen(port, "0.0.0.0", () => {
    console.log(`[main] Ecobee MCP server listening on 0.0.0.0:${port}`);
    console.log(`[main] Auth mode: ${authMode}`);
    console.log(
      `[main] MCP bearer auth: ${authToken ? "enabled" : "disabled"}`,
    );
    console.log(`[main] Plugins loaded: ${plugins.length}`);
    console.log(
      `[main] MCP performance caches: ${performanceCaches ? "enabled" : "disabled"}`,
    );
    console.log(
      `[main] Tool catalog reload: ${pluginsEnabled ? "SIGHUP" : "disabled"}`,
    );
  });

  if (pluginsEnabled) {
    process.on("SIGHUP", () => {
      void service.reloadCatalog().then((result) => {
        if (!result.accepted) {
          console.error("[main] Tool catalog reload rejected");
        } else if (result.changed) {
          console.log(
            `[main] Tool catalog generation ${result.generation} published`,
          );
          if (result.error) {
            console.error("[main] Tool catalog change notification failed");
          }
        } else {
          console.log("[main] Tool handlers refreshed; catalog unchanged");
        }
      });
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[main] Shutting down");
    await service.close();
    listener.close((error) => {
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : 3000;
}

function parseAuthMode(value: string | undefined): AuthMode {
  return value === "full" ? "full" : "readonly";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch(() => {
    console.error("[main] Fatal startup error");
    process.exit(1);
  });
}
