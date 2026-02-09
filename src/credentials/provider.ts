import type { EcobeeCredentials } from "../ecobee/types.js";

/**
 * Interface for credential storage backends.
 * Default implementation reads/writes a JSON file.
 * Plugins can provide custom implementations (e.g., read-only from another app's DB).
 */
export interface CredentialProvider {
  getCredentials(): Promise<EcobeeCredentials>;
  saveCredentials(creds: EcobeeCredentials): Promise<void>;
}
