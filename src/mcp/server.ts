import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetContractStatusTool } from "./tools/get_contract_status.js";

export function createMcpServer(getDb: () => Database.Database): McpServer {
    const server = new McpServer({
        name: "sorokeep",
        version: "0.1.2",
    });

    registerGetContractStatusTool(server, getDb);

    return server;
}
