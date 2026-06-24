import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetExtensionCostsTool } from "./tools/get-extension-costs.js";

export function createMcpServer(): McpServer {
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

    registerGetExtensionCostsTool(server);

    return server;
}

export async function startMcpServer(): Promise<void> {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
