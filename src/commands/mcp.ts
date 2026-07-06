import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDatabase } from "../db/database.js";
import { createMcpServer } from "../mcp/server.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start the Model Context Protocol (MCP) server on stdio transport")
    .action(async () => {
      try {
        const server = createMcpServer(() => getDatabase());
        const transport = new StdioServerTransport();
        await server.connect(transport);
      } catch (error: any) {
        console.error("MCP server error:", error);
        process.exit(1);
      }
    });
}
