import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, upsertEntry } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return { ...actual, getDatabase: () => mockDb };
});

async function callTool(toolName: string, args: Record<string, unknown>) {
    const { createMcpServer } = await import("../../src/mcp/server.js");
    const server = createMcpServer();
    // Access the registered tool callback directly to avoid needing a transport
    const tool = (server as any)._registeredTools[toolName];
    if (!tool) throw new Error(`Tool "${toolName}" not registered`);
    return tool.callback(args);
}

describe("MCP server — list_watched_contracts tool", () => {
    const CONTRACT_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const CONTRACT_B = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("returns an empty list when no contracts are registered", async () => {
        const result = await callTool("list_watched_contracts", {});
        const contracts = JSON.parse(result.content[0].text);
        expect(contracts).toEqual([]);
    });

    it("returns all registered contracts with id, name, network, and health", async () => {
        insertContract(mockDb, { id: CONTRACT_A, name: "XLM Token", network: "testnet" });
        insertContract(mockDb, { id: CONTRACT_B, name: "My Contract", network: "mainnet" });

        const result = await callTool("list_watched_contracts", {});
        const contracts = JSON.parse(result.content[0].text);

        expect(contracts).toHaveLength(2);
        expect(contracts[0]).toMatchObject({ id: CONTRACT_A, name: "XLM Token", network: "testnet" });
        expect(contracts[0]).toHaveProperty("health");
        expect(contracts[1]).toMatchObject({ id: CONTRACT_B, name: "My Contract", network: "mainnet" });
    });

    it("reports 'ok' health for a contract with healthy TTLs", async () => {
        insertContract(mockDb, { id: CONTRACT_A, name: "Healthy", network: "testnet" });
        mockDb.prepare("UPDATE contracts SET last_checked_ledger = 100000 WHERE id = ?").run(CONTRACT_A);
        upsertEntry(mockDb, {
            contract_id: CONTRACT_A,
            entry_key_xdr: "AAAA1234",
            entry_type: "instance",
            live_until_ledger: 200000, // remaining = 100000 → ok
            last_modified_ledger: 100,
        });

        const result = await callTool("list_watched_contracts", {});
        const contracts = JSON.parse(result.content[0].text);

        expect(contracts[0].health).toBe("ok");
    });

    it("reports 'critical' health when an entry TTL is critically low", async () => {
        insertContract(mockDb, { id: CONTRACT_A, name: "Critical", network: "testnet" });
        mockDb.prepare("UPDATE contracts SET last_checked_ledger = 100000 WHERE id = ?").run(CONTRACT_A);
        upsertEntry(mockDb, {
            contract_id: CONTRACT_A,
            entry_key_xdr: "AAAA1234",
            entry_type: "instance",
            live_until_ledger: 101000, // remaining = 1000 → critical
            last_modified_ledger: 100,
        });

        const result = await callTool("list_watched_contracts", {});
        const contracts = JSON.parse(result.content[0].text);

        expect(contracts[0].health).toBe("critical");
    });

    it("reports 'unknown' health when no entries or last_checked_ledger is null", async () => {
        insertContract(mockDb, { id: CONTRACT_A, name: "No Entries", network: "testnet" });

        const result = await callTool("list_watched_contracts", {});
        const contracts = JSON.parse(result.content[0].text);

        expect(contracts[0].health).toBe("unknown");
    });
});
