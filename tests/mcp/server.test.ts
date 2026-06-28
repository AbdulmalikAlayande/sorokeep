import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertEntry } from "../../src/db/repositories.js";
import { invokeListWatchedContracts } from "../../src/mcp/server.js";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

describe("MCP server — list_watched_contracts tool", () => {
    let mockDb: Database.Database;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns an empty list when no contracts are registered", async () => {
        const result = await invokeListWatchedContracts(mockDb);
        const data = JSON.parse(result.content[0].text);
        expect(data).toEqual([]);
    });

    it("returns all registered contracts with id, name, network, and health", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "test-contract",
            network: "testnet",
        });
        
        const result = await invokeListWatchedContracts(mockDb);
        const data = JSON.parse(result.content[0].text);
        
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({
            id: CONTRACT_ID,
            name: "test-contract",
            network: "testnet",
            health: "unknown",
        });
    });

    it("reports 'ok' health for a contract with healthy TTLs", async () => {
        insertContract(mockDb, { id: CONTRACT_ID, network: "testnet" });
        mockDb.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            1_000_000,
            CONTRACT_ID,
        );
        upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "foo",
            entry_type: "instance",
            live_until_ledger: 1_200_000,
            discovery_source: "manual",
        });

        const result = await invokeListWatchedContracts(mockDb);
        const data = JSON.parse(result.content[0].text);
        expect(data[0].health).toBe("ok");
    });

    it("reports 'critical' health when an entry TTL is critically low", async () => {
        insertContract(mockDb, { id: CONTRACT_ID, network: "testnet" });
        mockDb.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            1_000_000,
            CONTRACT_ID,
        );
        upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "foo",
            entry_type: "instance",
            live_until_ledger: 1_004_999,
            discovery_source: "manual",
        });

        const result = await invokeListWatchedContracts(mockDb);
        const data = JSON.parse(result.content[0].text);
        expect(data[0].health).toBe("critical");
    });

    it("reports 'unknown' health when no entries or last_checked_ledger is null", async () => {
        insertContract(mockDb, { id: CONTRACT_ID, network: "testnet" });
        
        const result = await invokeListWatchedContracts(mockDb);
        const data = JSON.parse(result.content[0].text);
        expect(data[0].health).toBe("unknown");
    });
});
