import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetContractStatusTool } from "./tools/get_contract_status.js";
import { registerGetExtensionCostsTool } from "./tools/get-extension-costs.js";
import { getAllContracts, getEntriesForContract } from "../db/repositories.js";
import { classifyTTL } from "../utils/formatting.js";
import type { TTLStatus } from "../utils/formatting.js";
import type { SorokeepConfig } from "../utils/config.js";
import { resolveToken, verifyRequest } from "./auth.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "MCPServer" });

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

export function createMcpServer(
    getDb: () => Database.Database,
    config: SorokeepConfig,
): McpServer {
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

    // Resolve authentication token
    const configuredToken = resolveToken(config);
    
    if (configuredToken === null) {
        logger.warn(
            "MCP server running without authentication — set SOROKEEP_MCP_TOKEN or mcpAuthToken in config to restrict access",
        );
    } else {
        logger.debug("MCP server authentication enabled: token configured");
    }

    // Store configured token in server context for middleware
    const serverWithAuth = server as McpServer & { __configuredToken?: string | null };
    serverWithAuth.__configuredToken = configuredToken;

    registerGetContractStatusTool(server, getDb);
    registerGetExtensionCostsTool(server);

    server.tool(
        "list_watched_contracts",
        "List all contracts registered for TTL monitoring with their current health status",
        async () => invokeListWatchedContracts(getDb()),
    );

    return server;
}
