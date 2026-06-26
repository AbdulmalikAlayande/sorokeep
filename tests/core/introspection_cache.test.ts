/**
 * TDD integration tests for issue #162 — cache get_monitored_keys introspection
 * results in SQLite to minimize RPC calls.
 *
 * These tests cover the watchContract behaviour:
 *  - Subsequent runs skip introspection RPC if cache is still valid (< 24 h)
 *  - forceRefresh: true always re-introspects regardless of cache age
 *  - Cache just expired triggers a fresh RPC call
 *  - last_introspected_at is written after a successful introspection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    getContract,
    updateLastIntrospectedAt,
    insertContract,
    upsertEntry,
} from "../../src/db/repositories";
import { watchContract } from "../../src/core/watch";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetContractInstanceEntry = vi.fn();
const mockGetWasmCodeEntry = vi.fn();
const mockGetEntryTTLs = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getContractInstanceEntry = mockGetContractInstanceEntry;
        getWasmCodeEntry = mockGetWasmCodeEntry;
        getEntryTTLs = mockGetEntryTTLs;
    }
    return { StellarRpcClient: MockStellarRpcClient };
});

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_CID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
const MOCK_LEDGER = 2_443_398;

const MOCK_INSTANCE = {
    entryKeyXdr: "instance-key-xdr",
    latestLedger: MOCK_LEDGER,
    liveUntilLedgerSeq: MOCK_LEDGER + 10_000,
    lastModifiedLedgerSeq: MOCK_LEDGER - 500,
    remainingTTL: 10_000,
    executableType: "contractExecutableWasm",
    wasmHash: "ab".repeat(32),
};

const MOCK_WASM = {
    entryKeyXdr: "wasm-key-xdr",
    latestLedger: MOCK_LEDGER,
    liveUntilLedgerSeq: MOCK_LEDGER + 50_000,
    lastModifiedLedgerSeq: MOCK_LEDGER - 1_000,
    remainingTTL: 50_000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a contract that has already been introspected N milliseconds ago. */
function seedIntrospectedContract(
    db: Database.Database,
    msAgo: number,
    contractId = VALID_CID,
): void {
    insertContract(db, { id: contractId, network: "testnet", wasm_hash: "ab".repeat(32) });
    // Seed the entries that a previous introspection would have stored
    upsertEntry(db, {
        contract_id: contractId,
        entry_key_xdr: "instance-key-xdr",
        entry_type: "instance",
        live_until_ledger: MOCK_LEDGER + 10_000,
        last_modified_ledger: MOCK_LEDGER - 500,
        discovery_source: "deterministic",
    });
    upsertEntry(db, {
        contract_id: contractId,
        entry_key_xdr: "wasm-key-xdr",
        entry_type: "wasm",
        live_until_ledger: MOCK_LEDGER + 50_000,
        last_modified_ledger: MOCK_LEDGER - 1_000,
        discovery_source: "deterministic",
    });
    const ts = new Date(Date.now() - msAgo).toISOString();
    updateLastIntrospectedAt(db, contractId, ts);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("watchContract — introspection cache (issue #162)", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetContractInstanceEntry.mockResolvedValue(MOCK_INSTANCE);
        mockGetWasmCodeEntry.mockResolvedValue(MOCK_WASM);
    });

    // =========================================================================
    // 1. FIRST-TIME INTROSPECTION — no cache, RPC must be called
    // =========================================================================

    it("calls getContractInstanceEntry on first watch (no cache)", async () => {
        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).toHaveBeenCalledTimes(1);
    });

    it("writes last_introspected_at after a successful first introspection", async () => {
        await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        const contract = getContract(db, VALID_CID);
        expect(contract!.last_introspected_at).not.toBeNull();
        // Should be a recent timestamp
        const diff = Date.now() - new Date(contract!.last_introspected_at as string).getTime();
        expect(diff).toBeLessThan(5_000); // within 5 s of now
    });

    // =========================================================================
    // 2. CACHE HIT — subsequent daemon run within 24 h must skip RPC
    // =========================================================================

    it("skips getContractInstanceEntry when cache is 1 hour old (valid)", async () => {
        seedIntrospectedContract(db, 60 * 60 * 1_000); // 1 h ago

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).not.toHaveBeenCalled();
        expect(mockGetWasmCodeEntry).not.toHaveBeenCalled();
    });

    it("skips introspection when cache is 23 h 59 min old (still valid)", async () => {
        const almostExpired = (23 * 60 + 59) * 60 * 1_000;
        seedIntrospectedContract(db, almostExpired);

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).not.toHaveBeenCalled();
    });

    it("returns success from cached data without an RPC call", async () => {
        seedIntrospectedContract(db, 2 * 60 * 60 * 1_000); // 2 h ago

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        // cached result shape
        if (result.success) {
            expect(result.contractId).toBe(VALID_CID);
        }
    });

    // =========================================================================
    // 3. CACHE MISS — expired cache must trigger fresh RPC call
    // =========================================================================

    it("calls getContractInstanceEntry when cache is exactly 24 h old (expired)", async () => {
        seedIntrospectedContract(db, 24 * 60 * 60 * 1_000); // exactly 24 h ago

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).toHaveBeenCalledTimes(1);
    });

    it("calls getContractInstanceEntry when cache is 25 h old (just expired)", async () => {
        seedIntrospectedContract(db, 25 * 60 * 60 * 1_000); // 25 h ago

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).toHaveBeenCalledTimes(1);
    });

    it("updates last_introspected_at after a cache-miss re-introspection", async () => {
        const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
        seedIntrospectedContract(db, 25 * 60 * 60 * 1_000);

        await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        const contract = getContract(db, VALID_CID);
        expect(contract!.last_introspected_at).not.toBe(oldTs);
        const diff = Date.now() - new Date(contract!.last_introspected_at as string).getTime();
        expect(diff).toBeLessThan(5_000);
    });

    // =========================================================================
    // 4. FORCE REFRESH — always re-introspect regardless of cache age
    // =========================================================================

    it("calls getContractInstanceEntry when forceRefresh=true even with a fresh cache", async () => {
        seedIntrospectedContract(db, 5 * 60 * 1_000); // 5 min ago — well within 24 h

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            forceRefresh: true,
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).toHaveBeenCalledTimes(1);
    });

    it("updates last_introspected_at after a forced re-introspection", async () => {
        const oldTs = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
        seedIntrospectedContract(db, 5 * 60 * 1_000);

        await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            forceRefresh: true,
        });

        const contract = getContract(db, VALID_CID);
        // Timestamp must have advanced
        expect(new Date(contract!.last_introspected_at as string).getTime()).toBeGreaterThan(
            new Date(oldTs).getTime(),
        );
    });

    it("forceRefresh=false (explicit) behaves like the default — respects cache", async () => {
        seedIntrospectedContract(db, 60 * 60 * 1_000); // 1 h ago

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            forceRefresh: false,
        });

        expect(result.success).toBe(true);
        expect(mockGetContractInstanceEntry).not.toHaveBeenCalled();
    });

    // =========================================================================
    // 5. EXISTING TESTS STILL PASS — ensure existing behaviour is preserved
    // =========================================================================

    it("still fails with a meaningful error when contract ID is invalid", async () => {
        const result = await watchContract(db, {
            contractId: "INVALID-CID",
            network: "testnet",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid|format|address/i);
        expect(mockGetContractInstanceEntry).not.toHaveBeenCalled();
    });

    it("still returns error when contract is not found on-chain (no cache exists)", async () => {
        mockGetContractInstanceEntry.mockResolvedValue(null);

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
    });

    it("does NOT update last_introspected_at when the RPC call fails", async () => {
        mockGetContractInstanceEntry.mockRejectedValue(new Error("RPC timeout"));

        await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        // Contract might not even be in DB, but if it is, last_introspected_at must stay null
        const contract = getContract(db, VALID_CID);
        if (contract) {
            expect(contract.last_introspected_at).toBeNull();
        }
    });

    it("does NOT update last_introspected_at when contract is not found on-chain", async () => {
        mockGetContractInstanceEntry.mockResolvedValue(null);

        await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        const contract = getContract(db, VALID_CID);
        if (contract) {
            expect(contract.last_introspected_at).toBeNull();
        }
    });

    // =========================================================================
    // 6. MULTIPLE CONTRACTS — caches are independent
    // =========================================================================

    it("caches are independent across different contracts", async () => {
        const CID2 = "CBEK0975FU6KKOEZ7RMTSGTDELBS5D6LVATIGCESOGXSZEQ2UWQFKZW9";
        // First contract has fresh cache
        seedIntrospectedContract(db, 30 * 60 * 1_000, VALID_CID); // 30 min ago

        // Second contract has expired cache
        seedIntrospectedContract(db, 25 * 60 * 60 * 1_000, CID2); // 25 h ago

        // Watch first (cached — no RPC)
        await watchContract(db, { contractId: VALID_CID, network: "testnet" });
        expect(mockGetContractInstanceEntry).not.toHaveBeenCalled();

        // Watch second (expired — RPC should be called)
        await watchContract(db, { contractId: CID2, network: "testnet" });
        expect(mockGetContractInstanceEntry).toHaveBeenCalledTimes(1);
    });
});
