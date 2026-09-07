import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { registerGetContractStatusTool } from "./tools/get_contract_status.js";
import { registerGetExtensionCostsTool } from "./tools/get-extension-costs.js";
import { getAllContracts, getEntriesForContract } from "../db/repositories.js";
import { classifyTTL } from "../utils/formatting.js";
import type { TTLStatus } from "../utils/formatting.js";
import { instrumentMcpToolInvocations } from "../observability/metrics/mcp.js";
import { resolveToken, verifyRequest, extractBearerToken } from "./auth.js";
import { ToolRateLimiter, DEFAULT_REQUESTS_PER_MINUTE } from "./rateLimiter.js";
import { applyMcpPermissions, READ_ONLY_ANNOTATIONS } from "./permissions.js";
import { getMcpMode, type SorokeepConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "MCPServer" });

/**
 * Wrap an MCP server's `.tool()` registration so every call is gated by
 * `configuredToken` (issue #410). Enforcement is real, not cosmetic: it runs
 * on every tool invocation via the same interception point as the metrics
 * wrapper, and denies with McpError when a token is configured and missing
 * or wrong.
 *
 * Scope note: the MCP SDK only populates `extra.requestInfo` (and therefore
 * HTTP headers) for HTTP-based transports — for the stdio transport this
 * server currently uses, there is no per-call request to carry a Bearer
 * token on, so a configured token cannot be checked per-call and access is
 * left open (the trust boundary for stdio is the process spawn itself, and
 * a false rejection there would be more misleading than an honest no-op).
 * This makes the check start enforcing correctly the moment an HTTP
 * transport is wired up, with no further changes needed here.
 */
export function enforceMcpAuth<T extends { tool: (...args: any[]) => any }>(server: T, configuredToken: string | null): T {
    if (configuredToken === null) return server;

    const originalTool = server.tool.bind(server);

    server.tool = ((...args: any[]) => {
        const toolName = args[0] as string;
        const lastIndex = args.length - 1;
        const originalCallback = args[lastIndex] as (...cbArgs: any[]) => unknown;

        args[lastIndex] = async (...cbArgs: any[]) => {
            const extra = cbArgs[cbArgs.length - 1] as { requestInfo?: unknown } | undefined;
            if (extra?.requestInfo !== undefined) {
                const provided = extractBearerToken(extra.requestInfo);
                if (!verifyRequest(provided, configuredToken)) {
                    logger.warn(`Rejected unauthenticated MCP tool call: ${toolName}`);
                    throw new McpError(ErrorCode.InvalidRequest, "Unauthorized: missing or invalid bearer token");
                }
            }
            return originalCallback(...cbArgs);
        };

        return originalTool(...args);
    }) as T["tool"];

    return server;
}

/**
 * Wrap an MCP server's `.tool()` registration so every call is throttled by
 * a fixed-window rate limit, scoped per tool name (issue #411). Protects the
 * daemon's shared SQLite connection from a runaway AI loop or malicious
 * client hammering a tool. Enforcement runs on every real invocation via the
 * same interception point as the auth/metrics wrappers, regardless of
 * transport (stdio or HTTP both call the wrapped callback per tool call).
 */
export function enforceMcpRateLimit<T extends { tool: (...args: any[]) => any }>(server: T, limiter: ToolRateLimiter): T {
    const originalTool = server.tool.bind(server);

    server.tool = ((...args: any[]) => {
        const toolName = args[0] as string;
        const lastIndex = args.length - 1;
        const originalCallback = args[lastIndex] as (...cbArgs: any[]) => unknown;

        args[lastIndex] = async (...cbArgs: any[]) => {
            if (!limiter.tryConsume(toolName)) {
                logger.warn(`Rate limit exceeded for MCP tool: ${toolName}`);
                throw new McpError(ErrorCode.InternalError, `Rate limit exceeded for tool ${toolName}. Try again later.`);
            }
            return originalCallback(...cbArgs);
        };

        return originalTool(...args);
    }) as T["tool"];

    return server;
}

export async function invokeListWatchedContracts(db: Database.Database) {
    const contracts = getAllContracts(db);

    const result = contracts.map((contract) => {
        const entries = getEntriesForContract(db, contract.id);
        const lastLedger = contract.last_checked_ledger ?? null;

        let health: TTLStatus | "unknown" = "unknown";
        if (entries.length > 0 && lastLedger != null) {
            const statuses = entries
                .filter((e) => e.live_until_ledger != null)
                .map((e) => classifyTTL(e.live_until_ledger - lastLedger));

            if (statuses.includes("expired")) health = "expired";
            else if (statuses.includes("critical")) health = "critical";
            else if (statuses.includes("warning")) health = "warning";
            else if (statuses.includes("ok")) health = "ok";
        }

        return {
            id: contract.id,
            name: contract.name ?? null,
            network: contract.network,
            health,
        };
    });

    return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
}

export function createMcpServer(getDb: () => Database.Database, config?: SorokeepConfig): McpServer {
    const server = new McpServer(
        {
            name: "sorokeep",
            version: "0.1.2",
        },
        {
            capabilities: {
                tools: {},
            },
            instructions:
                "Sorokeep MCP server exposes Soroban contract operations data for AI-assisted development.",
        },
    );

    const configuredToken = config ? resolveToken(config) : null;
    if (configuredToken === null) {
        logger.warn(
            "MCP server running without authentication — set SOROKEEP_MCP_TOKEN or mcpAuthToken in config to restrict access over HTTP transports",
        );
    } else {
        logger.debug("MCP server authentication enabled: token configured");
    }

    const rateLimiter = new ToolRateLimiter(config?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE);

    // Permissions first, metrics/auth/rate-limit after, so a tool call
    // refused by the mode check is not counted as an invocation and never
    // reaches the other checks.
    applyMcpPermissions(server, config ? getMcpMode(config) : undefined);
    instrumentMcpToolInvocations(server);
    enforceMcpAuth(server, configuredToken);
    enforceMcpRateLimit(server, rateLimiter);

    registerGetContractStatusTool(server, getDb);
    registerGetExtensionCostsTool(server);

    server.tool(
        "list_watched_contracts",
        "List all contracts registered for TTL monitoring with their current health status",
        READ_ONLY_ANNOTATIONS,
        async () => invokeListWatchedContracts(getDb()),
    );

    return server;
}
