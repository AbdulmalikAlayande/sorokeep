/**
 * TDD tests for rate limiter DB layer — countExtensionsInLastHour
 *
 * These tests are written FIRST, before the implementation, following the
 * strict Test-Driven Development requirements of issues #133 and #142.
 *
 * countExtensionsInLastHour(db, contractId) must:
 *   - Return 0 when there are no extension records for the contract.
 *   - Count only records from the past hour (executed_at >= now - 1 hour).
 *   - Exclude records older than one hour.
 *   - Count records for the given contract only (not other contracts).
 *   - Handle the boundary: a record at exactly one hour ago is excluded
 *     (strictly greater-than).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    recordExtension,
    countExtensionsInLastHour,
} from "../../src/db/repositories.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedContractWithEntry(
    db: Database.Database,
    contractId = "CTEST1111111111111111111111111111111111111111111111111111",
    network = "testnet",
): number {
    insertContract(db, { id: contractId, name: "Rate Limit Test", network });
    upsertEntry(db, {
        contract_id: contractId,
        entry_key_xdr: "instance-key-xdr",
        entry_type: "instance",
        label: "Contract Instance",
        live_until_ledger: 2_500_000,
        last_modified_ledger: 2_400_000,
        discovery_source: "deterministic",
    });

    const row = db
        .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
        .get(contractId) as { id: number };
    return row.id;
}

/**
 * Insert a raw extension_history record with an explicit executed_at timestamp
 * so we can test time-windowing without waiting for real time to pass.
 */
function insertExtensionAt(
    db: Database.Database,
    contractId: string,
    entryId: number,
    executedAt: string, // ISO-8601 string
): void {
    db.prepare(`
        INSERT INTO extension_history
            (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
             tx_hash, executed_at_ledger, executed_at)
        VALUES (?, ?, 1000, 2000, 'txhash-' || hex(randomblob(4)), 100, ?)
    `).run(contractId, entryId, executedAt);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("countExtensionsInLastHour", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    afterEach(() => {
        db.close();
    });

    it("returns 0 when no extension records exist for the contract", () => {
        seedContractWithEntry(db);
        const count = countExtensionsInLastHour(db, "CTEST1111111111111111111111111111111111111111111111111111");
        expect(count).toBe(0);
    });

    it("returns 0 for a contract that has never had extensions", () => {
        seedContractWithEntry(db);
        // Seed a different contract WITH extensions to ensure isolation
        const other = "COTHER111111111111111111111111111111111111111111111111111";
        const otherId = seedContractWithEntry(db, other);
        const now = new Date().toISOString();
        insertExtensionAt(db, other, otherId, now);

        const count = countExtensionsInLastHour(
            db,
            "CTEST1111111111111111111111111111111111111111111111111111",
        );
        expect(count).toBe(0);
    });

    it("counts one extension that just happened (within the last hour)", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        const now = new Date().toISOString();
        insertExtensionAt(db, contractId, entryId, now);

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(1);
    });

    it("counts multiple extensions within the last hour", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const now = new Date().toISOString();

        insertExtensionAt(db, contractId, entryId, thirtyMinAgo);
        insertExtensionAt(db, contractId, entryId, fifteenMinAgo);
        insertExtensionAt(db, contractId, entryId, now);

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(3);
    });

    it("excludes extensions older than one hour", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        // 2 hours ago — should be excluded
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        insertExtensionAt(db, contractId, entryId, twoHoursAgo);

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(0);
    });

    it("counts only extensions within the last hour when mixed with older ones", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        // Old — excluded
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        insertExtensionAt(db, contractId, entryId, twoHoursAgo);

        // Recent — counted
        const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        insertExtensionAt(db, contractId, entryId, twentyMinAgo);
        const now = new Date().toISOString();
        insertExtensionAt(db, contractId, entryId, now);

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(2);
    });

    it("counts extensions only for the specified contract (not other contracts)", () => {
        const contract1 = "CTEST1111111111111111111111111111111111111111111111111111";
        const contract2 = "COTHER111111111111111111111111111111111111111111111111111";

        const entryId1 = seedContractWithEntry(db, contract1);
        const entryId2 = seedContractWithEntry(db, contract2);

        const now = new Date().toISOString();
        // 3 extensions for contract1, 5 for contract2
        for (let i = 0; i < 3; i++) {
            insertExtensionAt(db, contract1, entryId1, now);
        }
        for (let i = 0; i < 5; i++) {
            insertExtensionAt(db, contract2, entryId2, now);
        }

        expect(countExtensionsInLastHour(db, contract1)).toBe(3);
        expect(countExtensionsInLastHour(db, contract2)).toBe(5);
    });

    it("handles the boundary: record at exactly 61 minutes ago is excluded", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        // 61 minutes ago — should be excluded (outside the 1-hour window)
        const sixtyOneMinAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
        insertExtensionAt(db, contractId, entryId, sixtyOneMinAgo);

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(0);
    });

    it("returns the correct count when exactly at the hourly rate limit (5)", () => {
        const contractId = "CTEST1111111111111111111111111111111111111111111111111111";
        const entryId = seedContractWithEntry(db, contractId);

        const now = new Date().toISOString();
        for (let i = 0; i < 5; i++) {
            insertExtensionAt(db, contractId, entryId, now);
        }

        const count = countExtensionsInLastHour(db, contractId);
        expect(count).toBe(5);
    });
});
