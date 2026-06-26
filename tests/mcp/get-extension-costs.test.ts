import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    recordExtension,
} from "../../src/db/repositories";
import { createMcpServer } from "../../src/mcp/server";
import { GET_EXTENSION_COSTS_TOOL_NAME } from "../../src/mcp/tools/get-extension-costs";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

let mockDb: Database.Database;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as typeof import("../../src/db/database");
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("get_extension_costs MCP tool", () => {
    let entryId: number;

    beforeEach(async () => {
        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });
        upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "XDR_KEY_1",
            entry_type: "instance",
            label: "contract-instance",
            live_until_ledger: 1000,
        });
        entryId = getEntriesForContract(mockDb, CONTRACT_ID)[0]!.id;

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        server = createMcpServer();
        client = new Client({ name: "test-client", version: "1.0.0" });

        await server.connect(serverTransport);
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        await client.close();
        await server.close();
    });

    it("registers the get_extension_costs tool on the MCP server", async () => {
        const tools = await client.listTools();

        expect(tools.tools.some((tool) => tool.name === GET_EXTENSION_COSTS_TOOL_NAME)).toBe(true);
    });

    it("returns detailed cost structures and projections via tool call", async () => {
        recordExtension(mockDb, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-instance",
            cost_xlm: 1.2,
            executed_at_ledger: 12345,
        });

        const result = await client.callTool({
            name: GET_EXTENSION_COSTS_TOOL_NAME,
            arguments: {
                contractId: CONTRACT_ID,
                period: 30,
            },
        });

        expect(result.isError).not.toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: "text" });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.summary).toEqual({
            totalExtensions: 1,
            totalCostXlm: 1.2,
        });
        expect(payload.byEntryType.instance).toEqual({
            count: 1,
            costXlm: 1.2,
        });
        expect(payload.projection).toEqual({
            estimated30DayCostXlm: 1.2,
            basisDays: 30,
            formula: "linear extrapolation from period average",
        });
        expect(payload.recentExtensions[0]).toMatchObject({
            entryLabel: "contract-instance",
            entryType: "instance",
            costXlm: 1.2,
            txHash: "hash-instance",
        });
    });

    it("returns an error when the contract is not watched", async () => {
        const result = await client.callTool({
            name: GET_EXTENSION_COSTS_TOOL_NAME,
            arguments: {
                contractId: "C" + "B".repeat(55),
                period: 30,
            },
        });

        expect(result.isError).toBe(true);
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload).toEqual({
            success: false,
            error: "contract_not_found",
            contractId: "C" + "B".repeat(55),
        });
    });

    it("returns an error when period is invalid", async () => {
        const result = await client.callTool({
            name: GET_EXTENSION_COSTS_TOOL_NAME,
            arguments: {
                contractId: CONTRACT_ID,
                period: -5,
            },
        });

        expect(result.isError).toBe(true);
    });
});
