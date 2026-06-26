#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDatabase } from "../db/database.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
    const server = createMcpServer(() => getDatabase());
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error: unknown) => {
    console.error("MCP server error:", error);
    process.exit(1);
});
