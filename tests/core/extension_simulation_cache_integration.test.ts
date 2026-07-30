import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { simulateExtension, extendEntries, clearSimulationCache } from "../../src/core/extension.js";
import * as rpcClient from "../../src/rpc/client.js";

/**
 * Integration tests for simulation cache in the extension flow.
 * 
 * Verifies that:
 * 1. Multiple simulations of the same footprint within TTL use cached results
 * 2. Cache is invalidated after successful extension
 * 3. Next simulation after extension triggers fresh RPC
 */

describe("Extension flow — simulation cache integration", () => {
    let db: Database.Database;
    let mockSimulateExtension: any;
    let mockSubmitExtension: any;
    let mockGetEntryTTLs: any;

    beforeEach(() => {
        db = getDatabaseForTesting();
        
        // Clear the global simulation cache before each test
        clearSimulationCache();

        // Seed a test contract with WASM hash
        db.exec(`
            INSERT INTO contracts (id, network, wasm_hash) 
            VALUES ('CTEST', 'testnet', 'wasm_hash_v1');
            
            INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, live_until_ledger, last_modified_ledger)
            VALUES 
                ('CTEST', 'entry1_xdr', 'persistent', 500000, 100),
                ('CTEST', 'entry2_xdr', 'persistent', 500001, 100);
                
            INSERT INTO extension_policies (contract_id, enabled, target_ttl_ledgers, extend_when_below_ledgers, keypair_source)
            VALUES ('CTEST', 1, 100000, 20000, 'STEST_SECRET_KEY_THAT_IS_EXACTLY_56_CHARS_LONG_FOR_STELLAR');
        `);

        // Mock RPC client methods
        mockSimulateExtension = vi.spyOn(rpcClient.StellarRpcClient.prototype, "simulateExtension");
        mockSimulateExtension.mockImplementation(async () => {
            return {
                minResourceFee: 50000,
                cpuInstructions: 100000,
                memoryBytes: 2048,
                readBytes: 1024,
                writeBytes: 512,
            };
        });

        mockSubmitExtension = vi.spyOn(rpcClient.StellarRpcClient.prototype, "submitExtension");
        mockSubmitExtension.mockResolvedValue({
            success: true,
            txHash: "tx_hash_123",
            ledger: 500500,
            feeCharged: 50000,
            cpuInsns: 100000,
            memBytes: 2048,
        });

        mockGetEntryTTLs = vi.spyOn(rpcClient.StellarRpcClient.prototype, "getEntryTTLs");
        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: 500500,
            entries: [
                { entryKeyXdr: "entry1_xdr", liveUntilLedgerSeq: 600000, lastModifiedLedgerSeq: 500500, remainingTTL: 99500 },
                { entryKeyXdr: "entry2_xdr", liveUntilLedgerSeq: 600001, lastModifiedLedgerSeq: 500500, remainingTTL: 99501 },
            ],
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        db.close();
    });

    // =========================================================================
    // ACCEPTANCE CRITERION 1: Cache hit within TTL
    // =========================================================================

    it("should cache simulation results for repeated calls with same footprint", async () => {
        const entryKeys = ["entry1_xdr", "entry2_xdr"];

        // First simulation - cache miss
        const result1 = await simulateExtension(
            db,
            "CTEST",
            entryKeys,
            100000,
            "GPUBLIC_KEY_SOURCE_ABC",
            undefined
        );

        expect(result1.success).toBe(true);
        expect(result1.estimatedFee).toBe(50000);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // Second simulation - cache hit (within default 60s TTL)
        const result2 = await simulateExtension(
            db,
            "CTEST",
            entryKeys,
            100000,
            "GPUBLIC_KEY_SOURCE_ABC",
            undefined
        );

        expect(result2.success).toBe(true);
        expect(result2.estimatedFee).toBe(50000);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1); // CRITICAL: No new RPC call

        // Third simulation - still cache hit
        const result3 = await simulateExtension(
            db,
            "CTEST",
            entryKeys,
            100000,
            "GPUBLIC_KEY_SOURCE_ABC",
            undefined
        );

        expect(result3.success).toBe(true);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1); // CRITICAL: Still no new RPC call
    });

    it("should treat different footprints as separate cache entries", async () => {
        const footprint1 = ["entry1_xdr"];
        const footprint2 = ["entry2_xdr"];
        const footprintBoth = ["entry1_xdr", "entry2_xdr"];

        // Simulate each footprint
        await simulateExtension(db, "CTEST", footprint1, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        await simulateExtension(db, "CTEST", footprint2, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2);

        await simulateExtension(db, "CTEST", footprintBoth, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(3);

        // Repeat - should all be cached
        await simulateExtension(db, "CTEST", footprint1, 100000, "GPUBKEY", undefined);
        await simulateExtension(db, "CTEST", footprint2, 100000, "GPUBKEY", undefined);
        await simulateExtension(db, "CTEST", footprintBoth, 100000, "GPUBKEY", undefined);

        expect(mockSimulateExtension).toHaveBeenCalledTimes(3); // No new calls
    });

    it("should normalize footprint order for consistent caching", async () => {
        const footprintA = ["entry1_xdr", "entry2_xdr"];
        const footprintB = ["entry2_xdr", "entry1_xdr"]; // Same keys, different order

        // First call
        await simulateExtension(db, "CTEST", footprintA, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // Second call with reversed order - should hit cache (normalized footprint)
        await simulateExtension(db, "CTEST", footprintB, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1); // CRITICAL: Cache hit despite order difference
    });

    // =========================================================================
    // ACCEPTANCE CRITERION 2: Cache invalidation after extension
    // =========================================================================

    it("should invalidate cache after successful extension", async () => {
        const entryKeys = ["entry1_xdr", "entry2_xdr"];

        // 1. Simulate (cache miss)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // 2. Simulate again (cache hit)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // 3. Actually extend the entries
        const extensionResult = await extendEntries(
            db,
            "CTEST",
            entryKeys,
            100000,
            "STEST_SECRET_KEY_THAT_IS_EXACTLY_56_CHARS_LONG_FOR_STELLAR",
            undefined
        );

        expect(extensionResult.success).toBe(true);

        // 4. Simulate again - should be cache miss (invalidated after extension)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2); // CRITICAL: New RPC call after invalidation
    });

    it("should only invalidate the extended footprint, not other cached entries", async () => {
        const footprint1 = ["entry1_xdr"];
        const footprint2 = ["entry2_xdr"];

        // Populate cache with both footprints
        await simulateExtension(db, "CTEST", footprint1, 100000, "GPUBKEY", undefined);
        await simulateExtension(db, "CTEST", footprint2, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2);

        // Extend only footprint1
        mockGetEntryTTLs.mockResolvedValueOnce({
            latestLedger: 500500,
            entries: [
                { entryKeyXdr: "entry1_xdr", liveUntilLedgerSeq: 600000, lastModifiedLedgerSeq: 500500, remainingTTL: 99500 },
            ],
        });

        await extendEntries(
            db,
            "CTEST",
            footprint1,
            100000,
            "STEST_SECRET_KEY_THAT_IS_EXACTLY_56_CHARS_LONG_FOR_STELLAR",
            undefined
        );

        // Simulate footprint1 - should trigger new RPC (invalidated)
        await simulateExtension(db, "CTEST", footprint1, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(3);

        // Simulate footprint2 - should still be cached (not invalidated)
        await simulateExtension(db, "CTEST", footprint2, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(3); // CRITICAL: No new call, still cached
    });

    // =========================================================================
    // EDGE CASES
    // =========================================================================

    it("should handle different WASM hashes as cache misses", async () => {
        const entryKeys = ["entry1_xdr"];

        // First simulation with wasm_hash_v1
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // Update WASM hash (simulating contract upgrade)
        db.exec(`UPDATE contracts SET wasm_hash = 'wasm_hash_v2_upgraded' WHERE id = 'CTEST'`);

        // Second simulation - should be cache miss (different WASM)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2);
    });

    it("should handle simulation errors without caching failures", async () => {
        const entryKeys = ["entry1_xdr"];

        // First call fails
        mockSimulateExtension.mockRejectedValueOnce(new Error("Simulation failed: insufficient balance"));

        const result1 = await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(result1.success).toBe(false);
        expect(result1.error).toContain("insufficient balance");
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // Second call succeeds
        mockSimulateExtension.mockResolvedValueOnce({
            minResourceFee: 50000,
            cpuInstructions: 100000,
            memoryBytes: 2048,
        });

        const result2 = await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(result2.success).toBe(true);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2); // CRITICAL: Failed simulation not cached, new call made
    });

    // =========================================================================
    // TYPICAL DAEMON CYCLE SCENARIO
    // =========================================================================

    it("should demonstrate typical daemon cycle: simulate → extend → invalidate → fresh simulate", async () => {
        const entryKeys = ["entry1_xdr", "entry2_xdr"];

        // Daemon Cycle 1: Check if extension needed
        // Step 1: Simulate to check cost/resources
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1);

        // Step 2: Decision made - needs extension, simulate again to be sure (should be cached)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(1); // Cached

        // Step 3: Submit extension
        const extResult = await extendEntries(
            db,
            "CTEST",
            entryKeys,
            100000,
            "STEST_SECRET_KEY_THAT_IS_EXACTLY_56_CHARS_LONG_FOR_STELLAR",
            undefined
        );
        expect(extResult.success).toBe(true);

        // Daemon Cycle 2: Next cycle checks again
        // Step 4: Fresh simulation (cache was invalidated after extension)
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2); // CRITICAL: Fresh RPC after invalidation

        // Step 5: Multiple checks within same cycle - should be cached
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        await simulateExtension(db, "CTEST", entryKeys, 100000, "GPUBKEY", undefined);
        expect(mockSimulateExtension).toHaveBeenCalledTimes(2); // Still cached within cycle
    });
});
