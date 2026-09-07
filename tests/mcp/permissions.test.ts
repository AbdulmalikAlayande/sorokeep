import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
    applyMcpPermissions,
    readOnlyRejectionMessage,
    READ_ONLY_ANNOTATIONS,
} from "../../src/mcp/permissions.js";
import { DEFAULT_MCP_MODE, getMcpMode } from "../../src/utils/config.js";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

/**
 * Registers a read-only and a write-capable tool on a server that has already
 * been wrapped by applyMcpPermissions, then connects a client to it.
 */
async function connectServerWithBothToolKinds(mode?: "read-only" | "read-write") {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });

    if (mode === undefined) applyMcpPermissions(server);
    else applyMcpPermissions(server, mode);

    server.registerTool(
        "read_tool",
        { description: "A read-only tool", annotations: READ_ONLY_ANNOTATIONS },
        async () => ({ content: [{ type: "text" as const, text: "read ok" }] }),
    );

    server.registerTool(
        "write_tool",
        { description: "A state-changing tool" },
        async () => ({ content: [{ type: "text" as const, text: "write ok" }] }),
    );

    server.tool(
        "legacy_read_tool",
        "A read-only tool registered through the legacy .tool() overload",
        READ_ONLY_ANNOTATIONS,
        async () => ({ content: [{ type: "text" as const, text: "legacy read ok" }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return { server, client };
}

describe("MCP permission modes", () => {
    let mockDb: Database.Database;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
    });

    describe("read-only mode", () => {
        let server: McpServer;
        let client: Client;

        beforeEach(async () => {
            ({ server, client } = await connectServerWithBothToolKinds("read-only"));
        });

        afterEach(async () => {
            await client.close();
            await server.close();
        });

        it("rejects a write-capable tool with a reason the caller can act on", async () => {
            const result = await client.callTool({ name: "write_tool", arguments: {} });

            expect(result.isError).toBe(true);
            const text = (result.content as { type: string; text: string }[])[0]!.text;
            expect(text).toBe(readOnlyRejectionMessage("write_tool"));
            expect(text).toContain("read-only");
            expect(text).toContain("write_tool");
            expect(text).not.toContain("write ok");
        });

        it("does not execute the rejected tool's handler", async () => {
            let ran = false;
            const bare = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
            applyMcpPermissions(bare, "read-only");
            bare.registerTool("mutating", { description: "mutates" }, async () => {
                ran = true;
                return { content: [{ type: "text" as const, text: "ran" }] };
            });

            const [ct, st] = InMemoryTransport.createLinkedPair();
            const c = new Client({ name: "c", version: "1.0.0" });
            await bare.connect(st);
            await c.connect(ct);

            await c.callTool({ name: "mutating", arguments: {} });
            expect(ran).toBe(false);

            await c.close();
            await bare.close();
        });

        it("still permits a read-only tool", async () => {
            const result = await client.callTool({ name: "read_tool", arguments: {} });

            expect(result.isError).toBeFalsy();
            expect((result.content as { text: string }[])[0]!.text).toBe("read ok");
        });

        it("permits a read-only tool registered through the legacy .tool() overload", async () => {
            const result = await client.callTool({ name: "legacy_read_tool", arguments: {} });

            expect(result.isError).toBeFalsy();
            expect((result.content as { text: string }[])[0]!.text).toBe("legacy read ok");
        });

        it("keeps write-capable tools listed so an agent can see what it is missing", async () => {
            const { tools } = await client.listTools();

            expect(tools.map((t) => t.name)).toContain("write_tool");
        });
    });

    describe("read-write mode", () => {
        let server: McpServer;
        let client: Client;

        beforeEach(async () => {
            ({ server, client } = await connectServerWithBothToolKinds("read-write"));
        });

        afterEach(async () => {
            await client.close();
            await server.close();
        });

        it("permits every tool", async () => {
            const write = await client.callTool({ name: "write_tool", arguments: {} });
            const read = await client.callTool({ name: "read_tool", arguments: {} });
            const legacy = await client.callTool({ name: "legacy_read_tool", arguments: {} });

            expect(write.isError).toBeFalsy();
            expect((write.content as { text: string }[])[0]!.text).toBe("write ok");
            expect(read.isError).toBeFalsy();
            expect(legacy.isError).toBeFalsy();
        });
    });

    describe("default mode", () => {
        it("is read-only", () => {
            expect(DEFAULT_MCP_MODE).toBe("read-only");
            expect(getMcpMode({ network: "testnet", pollingIntervalSeconds: 300 })).toBe("read-only");
        });

        it("rejects write-capable tools when no mode is passed", async () => {
            const { server, client } = await connectServerWithBothToolKinds();

            const result = await client.callTool({ name: "write_tool", arguments: {} });
            expect(result.isError).toBe(true);

            await client.close();
            await server.close();
        });
    });

    describe("createMcpServer", () => {
        it("tags every currently registered tool as read-only", async () => {
            const server = createMcpServer(() => mockDb, { mode: "read-only" });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "c", version: "1.0.0" });
            await server.connect(st);
            await client.connect(ct);

            const { tools } = await client.listTools();
            expect(tools.length).toBeGreaterThan(0);
            for (const tool of tools) {
                expect(tool.annotations?.readOnlyHint).toBe(true);
            }

            await client.close();
            await server.close();
        });

        it("serves its read-only tools normally in read-only mode", async () => {
            const server = createMcpServer(() => mockDb, { mode: "read-only" });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "c", version: "1.0.0" });
            await server.connect(st);
            await client.connect(ct);

            const result = await client.callTool({ name: "list_watched_contracts", arguments: {} });
            expect(result.isError).toBeFalsy();
            expect((result.content as { text: string }[])[0]!.text).toBe("[]");

            await client.close();
            await server.close();
        });

        it("serves its read-only tools normally in read-write mode", async () => {
            const server = createMcpServer(() => mockDb, { mode: "read-write" });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "c", version: "1.0.0" });
            await server.connect(st);
            await client.connect(ct);

            const result = await client.callTool({
                name: "get_contract_status",
                arguments: { contractId: CONTRACT_ID },
            });
            expect(result.isError).toBe(true);
            expect((result.content as { text: string }[])[0]!.text).not.toBe(
                readOnlyRejectionMessage("get_contract_status"),
            );

            await client.close();
            await server.close();
        });
    });
});
