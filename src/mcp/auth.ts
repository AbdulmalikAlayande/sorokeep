import type { SorokeepConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "MCPAuth" });

/**
 * Resolve the MCP authentication token from environment or config.
 * Environment variable SOROKEEP_MCP_TOKEN takes precedence over config.mcpAuthToken.
 *
 * Security: Never logs the token value, only logs whether a token is configured.
 *
 * @param config The Sorokeep configuration object
 * @returns The resolved token, or null if neither env var nor config field is set
 */
export function resolveToken(config: SorokeepConfig): string | null {
    const envToken = process.env.SOROKEEP_MCP_TOKEN;
    const configToken = config.mcpAuthToken;

    if (envToken) {
        logger.debug("MCP token resolved from environment variable");
        return envToken;
    }

    if (configToken) {
        logger.debug("MCP token resolved from config file");
        return configToken;
    }

    logger.debug("No MCP authentication token configured");
    return null;
}

/**
 * Verify a request against the configured authentication token.
 *
 * @param providedToken The token provided in the request (from Authorization header or handshake param)
 * @param configuredToken The configured token (from resolveToken)
 * @returns true if access is granted, false otherwise
 *
 * Logic:
 * - If no token is configured, grant access (backward compatible, open access)
 * - If token is configured, require exact match
 * - null/undefined/empty string all fail when token is required
 */
export function verifyRequest(
    providedToken: string | null | undefined,
    configuredToken: string | null
): boolean {
    // If no token is configured, grant access (backward compatible)
    if (configuredToken === null || configuredToken === undefined) {
        return true;
    }

    // Token is configured, require exact match
    // Fail if provided token is missing, null, undefined, or empty
    if (!providedToken) {
        return false;
    }

    // Case-sensitive comparison
    return providedToken === configuredToken;
}
