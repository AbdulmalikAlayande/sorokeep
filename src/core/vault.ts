import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "VaultResolver" });

export interface VaultConfig {
    url: string;
    token: string;
    namespace?: string;
}

export class VaultAuthError extends Error {
    constructor(message: string = "Vault authentication failed") {
        super(message);
        this.name = "VaultAuthError";
    }
}

export class VaultSecretNotFoundError extends Error {
    constructor(secretPath: string) {
        super(`Secret not found in Vault at path: ${secretPath}`);
        this.name = "VaultSecretNotFoundError";
    }
}

export class VaultSecretError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VaultSecretError";
    }
}

/**
 * VaultResolver - Retrieve Stellar secret keys dynamically from HashiCorp Vault
 *
 * Supports KV v1 and KV v2 secret engines.
 *
 * Secret lookup order for field names:
 *   secret_key, private_key, secret, value, stellar_secret, key
 *
 * You can also specify a custom field with a fragment: vault:secret/data/foo#my_field
 */
export class VaultResolver {
    private url: string;
    private token: string;
    private namespace?: string;

    constructor(config: VaultConfig) {
        if (!config.url) {
            throw new VaultSecretError("Vault URL is required");
        }
        if (!config.token) {
            throw new VaultAuthError("Vault token is required");
        }
        // Normalize URL (strip trailing slash)
        this.url = config.url.replace(/\/$/, "");
        this.token = config.token;
        this.namespace = config.namespace;
    }

    /**
     * Fetch a Stellar secret key from Vault
     * @param secretPath Vault secret path, optionally with #field suffix
     * @returns Stellar secret key string (starts with S)
     */
    async getSecret(secretPath: string): Promise<string> {
        // Parse field fragment
        let path = secretPath;
        let fieldName: string | null = null;

        const hashIdx = secretPath.indexOf("#");
        if (hashIdx !== -1) {
            path = secretPath.slice(0, hashIdx);
            fieldName = secretPath.slice(hashIdx + 1);
        }

        // Strip leading slash
        if (path.startsWith("/")) {
            path = path.slice(1);
        }

        const url = `${this.url}/v1/${path}`;

        const headers: Record<string, string> = {
            "X-Vault-Token": this.token,
            "Accept": "application/json",
        };

        if (this.namespace) {
            headers["X-Vault-Namespace"] = this.namespace;
        }

        let res: Response;
        try {
            res = await fetch(url, { headers });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Vault request failed: ${message}`);
            throw new VaultSecretError(`Vault request failed: ${message}`);
        }

        if (!res.ok) {
            if (res.status === 403 || res.status === 401) {
                throw new VaultAuthError(`Vault authentication failed (${res.status})`);
            }
            if (res.status === 404) {
                throw new VaultSecretNotFoundError(path);
            }
            let body = "";
            try {
                body = await res.text();
            } catch { /* ignore */ }
            throw new VaultSecretError(`Vault request failed with status ${res.status}: ${body}`);
        }

        let json: any;
        try {
            json = await res.json();
        } catch (err) {
            throw new VaultSecretError("Failed to parse Vault response as JSON");
        }

        // KV v2: data.data.{field}
        // KV v1: data.{field}
        let secretData: Record<string, any> | undefined;
        if (json?.data?.data && typeof json.data.data === "object") {
            secretData = json.data.data;
        } else if (json?.data && typeof json.data === "object") {
            secretData = json.data;
        }

        if (!secretData) {
            throw new VaultSecretError(`No secret data found at Vault path: ${path}`);
        }

        let secretValue: string | undefined;

        if (fieldName) {
            secretValue = secretData[fieldName];
            if (secretValue === undefined) {
                throw new VaultSecretError(
                    `Field '${fieldName}' not found in Vault secret at path: ${path}`
                );
            }
        } else {
            // Try common field names in order
            const candidates = [
                "secret_key",
                "private_key",
                "secret",
                "value",
                "stellar_secret",
                "key",
            ];
            for (const key of candidates) {
                if (typeof secretData[key] === "string") {
                    secretValue = secretData[key];
                    break;
                }
            }

            // Fallback: if there's exactly one string field that looks like a Stellar secret, use it
            if (!secretValue) {
                const stringEntries = Object.entries(secretData).filter(
                    ([, v]) => typeof v === "string"
                ) as [string, string][];
                if (stringEntries.length === 1) {
                    const first = stringEntries[0];
                    if (first) secretValue = first[1];
                } else {
                    // Try to find any Stellar-looking secret
                    const stellarEntry = stringEntries.find(([, v]) => isStellarSecret(v));
                    if (stellarEntry) {
                        secretValue = stellarEntry[1];
                    }
                }
            }
        }

        if (!secretValue || typeof secretValue !== "string") {
            throw new VaultSecretError(
                `No valid secret key found in Vault response at path: ${path}. ` +
                `Expected one of: secret_key, private_key, secret, value, stellar_secret, key`
            );
        }

        if (!isStellarSecret(secretValue)) {
            throw new VaultSecretError(
                `Secret retrieved from Vault is not a valid Stellar secret key format. ` +
                `Expected 56-character string starting with 'S', got: ${maskSecret(secretValue)}`
            );
        }

        logger.debug(`Successfully resolved secret from Vault path: ${path}`);
        return secretValue;
    }
}

/**
 * Check if a string looks like a Stellar secret key
 */
function isStellarSecret(value: string): boolean {
    return typeof value === "string" && value.startsWith("S") && value.length === 56;
}

function maskSecret(secret: string): string {
    if (secret.length <= 8) return "***";
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
