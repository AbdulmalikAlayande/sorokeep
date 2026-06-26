import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../db/database.js";
import { getAllContracts, getEntriesForContract } from "../db/repositories.js";
import { classifyTTL } from "../utils/formatting.js";
import type { TTLStatus } from "../utils/formatting.js";

export function createMcpServer(): McpServer {
    const server = new McpServer({ name: "sorokeep", version: "0.1.2" });

    server.tool(
        "list_watched_contracts",
        "List all contracts registered for TTL monitoring with their current health status",
        async () => {
            const db = getDatabase();
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
        },
    );

    return server;
}
