import type { McpServer } from "@modelcontextprotocol/server";
import type { CredentialProvider } from "../credentials/provider.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import type { EcobeeCredentials } from "../ecobee/types.js";

/**
 * Drop-in plugin interface.
 * Place a .js file exporting this shape in the plugins/ directory.
 */
export interface EcobeePlugin {
  name: string;
  credentialProvider?: CredentialProvider;
  onTokenRefresh?: (creds: EcobeeCredentials) => Promise<void>;
  registerTools?: (
    server: McpServer,
    api: EcobeeApiClient,
    cache: EcobeeCache,
  ) => void;
  registerResources?: (server: McpServer, cache: EcobeeCache) => void;
}
