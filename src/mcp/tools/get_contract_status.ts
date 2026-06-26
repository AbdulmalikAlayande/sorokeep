import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
    ContractNotFoundError,
    getContractStatus,
    type ContractStatus,
} from "../../core/status.js";

export async function invokeGetContractStatus(
    db: Database.Database,
    contractId: string,
): Promise<CallToolResult> {
    try {
        const status = getContractStatus(db, contractId);
        return formatContractStatusResult(status);
    } catch (error) {
        if (error instanceof ContractNotFoundError) {
            return {
                content: [{ type: "text", text: error.message }],
                isError: true,
            };
        }
        throw error;
    }
}

export function formatContractStatusResult(status: ContractStatus): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: { ...status },
    };
}

export function registerGetContractStatusTool(
    server: McpServer,
    getDb: () => Database.Database,
): void {
    server.registerTool(
        "get_contract_status",
        {
            title: "Get Contract Status",
            description:
                "Query TTL health metrics for a watched Soroban contract, including per-entry remaining lifespans.",
            inputSchema: {
                contractId: z.string().describe("Stellar contract address (C... format)"),
            },
        },
        async ({ contractId }) => invokeGetContractStatus(getDb(), contractId),
    );
}
