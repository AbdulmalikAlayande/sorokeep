import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { getDatabaseForTesting } from "../../src/db/database.js";

describe("MCP Server Lifecycle", () => {
    let mockDb: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
    });

    it("starts and listens on stdio transport and returns correct handshake parameters to client", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();

        const server = createMcpServer(() => mockDb);
        const transport = new StdioServerTransport({ stdin, stdout });

        await server.connect(transport);

        const responsePromise = new Promise<string>((resolve) => {
            stdout.on("data", (chunk) => {
                resolve(chunk.toString());
            });
        });

        const initializeRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: {
                    name: "test-client",
                    version: "1.0.0"
                }
            }
        };

        stdin.write(JSON.stringify(initializeRequest) + "\n");

        const responseStr = await responsePromise;
        const response = JSON.parse(responseStr);

        expect(response).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            result: {
                protocolVersion: "2024-11-05",
                serverInfo: {
                    name: "sorokeep",
                    version: expect.any(String),
                }
            }
        });

        await server.close();
    });

    it("handles invalid JSON-RPC messages gracefully on stdio", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();

        const server = createMcpServer(() => mockDb);
        const transport = new StdioServerTransport({ stdin, stdout });

        await server.connect(transport);

        const responsePromise = new Promise<string>((resolve) => {
            stdout.on("data", (chunk) => {
                resolve(chunk.toString());
            });
        });

        stdin.write("invalid json\n");

        const responseStr = await responsePromise;
        const response = JSON.parse(responseStr);

        expect(response).toMatchObject({
            jsonrpc: "2.0",
            error: {
                code: -32700,
                message: expect.any(String),
            }
        });

        await server.close();
    });
});
