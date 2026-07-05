/**
 * TDD tests for the auto-extension rate limiter — core layer
 *
 * Written FIRST before the implementation (strict TDD — issues #133, #137, #142).
 *
 * Tests cover:
 *   - isRateLimited(): returns true when ≥ HOURLY_RATE_LIMIT extensions in last hour
 *   - runAutoExtensions(): skips a contract (and emits an alert) when rate-limited
 *   - Rate limit alert is fired when a contract is blocked
 *   - Edge cases: exactly at limit vs one below limit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Keypair } from "@stellar/stellar-sdk";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    recordExtension,
} from "../../src/db/repositories.js";

// ─── Mock RPC client ─────────────────────────────────────────────────────────

const mockSubmitExtension = vi.fn();
const mockSubmitRestore = vi.fn();
const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();
const mockSimulateExtension = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    return {
        StellarRpcClient: class MockStellarRpcClient {
            constructor() {}
            submitExtension = mockSubmitExtension;
            submitRestore = mockSubmitRestore;
            getEntryTTLs = mockGetEntryTTLs;
            getCurrentLedger = mockGetCurrentLedger;
            simulateExtension = mockSimulateExtension;
        },
    };
});

// Import AFTER mocking
const { isRateLimited, HOURLY_RATE_LIMIT, runAutoExtensions } = await import(
    "../../src/core/extension.js"
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CTEST1111111111111111111111111111111111111111111111111111";

function seedContractAndPolicy(
    db: Database.Database,
    contractId = CONTRACT_ID,
    network = "testnet",
): number {
    insertContract(db, { id: contractId, name: "Rate Limit Test", network });

    upsertEntry(db, {
        contract_id: contractId,
        entry_key_xdr: "instance-key-xdr",
        entry_type: "instance",
        label: "Contract Instance",
        live_until_ledger: 2_540_000, // very low - below threshold - would trigger extension
        last_modified_ledger: 2_400_000,
        discovery_source: "deterministic",
    });

    upsertExtensionPolicy(db, {
        contract_id: contractId,
        enabled: true,
        target_ttl_ledgers: 100_000,
        extend_when_below_ledgers: 50_000, // 5000 < 50000 → should extend
        keypair_source: "env:TEST_STELLAR_SECRET",
    });

    const row = db
        .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
        .get(contractId) as { id: number };
    return row.id;
}

/**
 * Insert `n` extension records all within the last hour.
 */
function insertRecentExtensions(
    db: Database.Database,
    contractId: string,
    entryId: number,
    n: number,
): void {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
        db.prepare(`
            INSERT INTO extension_history
                (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                 tx_hash, executed_at_ledger, executed_at)
            VALUES (?, ?, 1000, 100000, 'txhash-' || hex(randomblob(4)), 100, ?)
        `).run(contractId, entryId, now);
    }
}

// ─── Tests: isRateLimited ────────────────────────────────────────────────────

describe("isRateLimited", () => {
    let db: Database.Database;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        db.close();
    });

    it("returns false when no extensions have occurred (count = 0)", () => {
        seedContractAndPolicy(db);
        const result = isRateLimited(db, CONTRACT_ID);
        expect(result).toBe(false);
    });

    it("returns false when count is below the hourly limit", () => {
        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT - 1);
        const result = isRateLimited(db, CONTRACT_ID);
        expect(result).toBe(false);
    });

    it("returns true when count equals the hourly limit", () => {
        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT);
        const result = isRateLimited(db, CONTRACT_ID);
        expect(result).toBe(true);
    });

    it("returns true when count exceeds the hourly limit", () => {
        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT + 3);
        const result = isRateLimited(db, CONTRACT_ID);
        expect(result).toBe(true);
    });

    it("uses the default limit of 5 per hour", () => {
        expect(HOURLY_RATE_LIMIT).toBe(5);
    });

    it("only considers extensions in the last hour (old ones don't count)", () => {
        const entryId = seedContractAndPolicy(db);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

        // Insert HOURLY_RATE_LIMIT old extensions — should not trigger the limit
        for (let i = 0; i < HOURLY_RATE_LIMIT; i++) {
            db.prepare(`
                INSERT INTO extension_history
                    (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                     tx_hash, executed_at_ledger, executed_at)
                VALUES (?, ?, 1000, 100000, 'old-txhash-' || ?, 100, ?)
            `).run(CONTRACT_ID, entryId, i, twoHoursAgo);
        }

        const result = isRateLimited(db, CONTRACT_ID);
        expect(result).toBe(false);
    });

    it("returns false for an unknown contract (no records)", () => {
        const result = isRateLimited(db, "CUNKNOWN_DOES_NOT_EXIST_111111111111111111111111111111");
        expect(result).toBe(false);
    });

    it("respects custom limit passed as optional argument", () => {
        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, 3);

        // With default limit (5) → not limited
        expect(isRateLimited(db, CONTRACT_ID)).toBe(false);
        // With custom limit of 2 → limited
        expect(isRateLimited(db, CONTRACT_ID, 2)).toBe(true);
    });
});

// ─── Tests: runAutoExtensions rate limiting integration ───────────────────────

describe("runAutoExtensions — rate limiting", () => {
    let db: Database.Database;
    const savedEnv: Record<string, string | undefined> = {};
    const DUMMY_SECRET = Keypair.random().secret();

    function setEnv(key: string, value: string) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();

        // Default mock behaviours
        mockGetCurrentLedger.mockResolvedValue(2_500_000);
        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: 2_500_000,
            entries: [
                {
                    entryKeyXdr: "instance-key-xdr",
                    liveUntilLedgerSeq: 2_540_000,
                    lastModifiedLedgerSeq: 2_400_000,
                    remainingTTL: 40_000,
                },
            ],
        });
        mockSubmitExtension.mockResolvedValue({
            success: true,
            txHash: "abc123",
            ledger: 2_500_001,
            cpuInsns: 100_000,
            memBytes: 512_000,
        });
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        db.close();
    });

    it("skips a rate-limited contract and records an error in the result", async () => {
        setEnv("TEST_STELLAR_SECRET", DUMMY_SECRET);

        const entryId = seedContractAndPolicy(db);
        // Saturate the rate limit
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT);

        const result = await runAutoExtensions(db, "testnet");

        // The contract was checked but NOT extended
        expect(result.contractsExtended).toBe(0);
        expect(result.entriesExtended).toBe(0);

        // An error/warning entry documents the rate-limit skip
        expect(result.errors.some(e => /rate.limit/i.test(e))).toBe(true);
    });

    it("allows extension when count is below the hourly limit", async () => {
        setEnv("TEST_STELLAR_SECRET", DUMMY_SECRET);

        const entryId = seedContractAndPolicy(db);
        // One below the limit
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT - 1);

        const result = await runAutoExtensions(db, "testnet");

        expect(result.contractsExtended).toBe(1);
        expect(result.entriesExtended).toBeGreaterThan(0);
    });

    it("does not call submitExtension for a rate-limited contract", async () => {
        setEnv("TEST_STELLAR_SECRET", DUMMY_SECRET);

        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT);

        await runAutoExtensions(db, "testnet");

        expect(mockSubmitExtension).not.toHaveBeenCalled();
    });

    it("rate-limits each contract independently", async () => {
        setEnv("TEST_STELLAR_SECRET", DUMMY_SECRET);

        const contract2 = "COTHER111111111111111111111111111111111111111111111111111";

        const entryId1 = seedContractAndPolicy(db, CONTRACT_ID);
        const entryId2 = seedContractAndPolicy(db, contract2);

        // Saturate contract1 only
        insertRecentExtensions(db, CONTRACT_ID, entryId1, HOURLY_RATE_LIMIT);
        // contract2 has 0 recent extensions → should be allowed

        const result = await runAutoExtensions(db, "testnet");

        // contract2 should have been extended; contract1 should not
        expect(result.contractsExtended).toBe(1);
        const extendedIds = result.extensions.map(e => e.contractId);
        expect(extendedIds).not.toContain(CONTRACT_ID);
        expect(extendedIds).toContain(contract2);
    });

    it("includes the contract id in the rate-limit error message", async () => {
        setEnv("TEST_STELLAR_SECRET", DUMMY_SECRET);

        const entryId = seedContractAndPolicy(db);
        insertRecentExtensions(db, CONTRACT_ID, entryId, HOURLY_RATE_LIMIT);

        const result = await runAutoExtensions(db, "testnet");

        expect(result.errors.some(e => e.includes(CONTRACT_ID))).toBe(true);
    });
});
