import type { SorokeepConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "MCPAuth" });

/**
 * Resolve the MCP authentication token from environment or config.
 * SOROKEEP_MCP_TOKEN takes precedence over config.mcpAuthToken so the token
 * itself need never be written to disk.
 *
 * Security: never logs the token value, only whether one is configured.
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
 * Verify a request-provided token against the configured token.
 *
 * - No token configured → access granted (backward compatible, open access).
 * - Token configured → exact, case-sensitive match required; missing/empty/
 *   mismatched tokens are all denied.
 */
export function verifyRequest(
    providedToken: string | null | undefined,
    configuredToken: string | null,
): boolean {
    if (configuredToken === null || configuredToken === undefined) {
        return true;
    }

    if (!providedToken) {
        return false;
    }

    return providedToken === configuredToken;
}

/**
 * Extract a Bearer token from an MCP tool-call's `extra.requestInfo` (only
 * populated when the server is attached to an HTTP-based transport — the
 * MCP SDK leaves `requestInfo` undefined for stdio, since there is no HTTP
 * request to carry headers on).
 */
export function extractBearerToken(requestInfo: unknown): string | null {
    if (!requestInfo || typeof requestInfo !== "object") return null;
    const headers = (requestInfo as { headers?: unknown }).headers;
    if (!headers) return null;

    let raw: string | undefined;
    if (typeof (headers as Headers).get === "function") {
        raw = (headers as Headers).get("authorization") ?? undefined;
    } else {
        raw = (headers as Record<string, string | string[] | undefined>)["authorization"] as string | undefined;
    }

    if (!raw) return null;
    const match = /^Bearer\s+(.+)$/i.exec(raw);
    return match ? match[1]! : null;
}
