import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../../db/database.js";
import { getExtensionCosts } from "../../core/costs.js";

export const GET_EXTENSION_COSTS_TOOL_NAME = "get_extension_costs";

export function registerGetExtensionCostsTool(server: McpServer): void {
    server.registerTool(
        GET_EXTENSION_COSTS_TOOL_NAME,
        {
            description:
                "Fetch rent cost history summaries and future cost projections for a watched Soroban contract",
            inputSchema: {
                contractId: z
                    .string()
                    .describe("The Soroban contract ID (56-character string starting with C)"),
                period: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Number of days of extension history to include (default: 30)"),
            },
        },
        async ({ contractId, period }) => {
            const db = getDatabase();
            const result = getExtensionCosts(db, contractId, { period });

            if (!result.success) {
                return {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
            };
        },
    );
}
