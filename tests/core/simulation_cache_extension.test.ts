import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getTestDb } from "../helpers/db.js";

/**
 * TDD tests for extension-decision simulation cache (continuation of phase-2 work).
 * 
 * Issue: Cache simulation results for unchanged entry footprints during auto-extension cycles.
 * 
 * Acceptance Criteria:
 *  1. A repeated simulation request within the cache TTL does not call the RPC client again.
 *  2. A cache entry is invalidated immediately after its entry is actually extended.
 * 
 * This extends the existing SimulationCacheManager from phase-2 to support:
 *  - Time-based TTL expiration (default: one polling interval, ~60s)
 *  - Explicit cache invalidation after successful extensions
 */

// ─── Import the cache manager we'll implement ─────────────────────────────────
// This will be moved to src/core/simulation_cache.ts
import { SimulationCacheManager } from "../../src/core/simulation_cache.js";
import type { SimulationResult } from "../../src/core/simulation_cache.js";

describe("TDD - Extension Decision Simulation Cache with TTL", () => {
    let cacheManager: SimulationCacheManager;
    let mockSimulationFallback: any;
    let standardResult: SimulationResult;

    beforeEach(() => {
        cacheManager = new SimulationCacheManager();
        
        standardResult = {
            cpuInstructions: 154000,
            memoryBytes: 4096,
            minResourceFee: 10000,
        };

        mockSimulationFallback = vi.fn().mockResolvedValue(standardResult);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // =========================================================================
    // ACCEPTANCE CRITERION 1: Repeated simulation within TTL returns cached result
    // =========================================================================

    it("should return cached simulation result for identical footprint within TTL", async () => {
        const footprintHash = "extension_footprint_abc";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // First call - cache miss, triggers RPC
        const result1 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        // Second call immediately after - cache hit, no RPC
        const result2 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        // Third call immediately after - still cache hit
        const result3 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        // All results should match
        expect(result1).toEqual(standardResult);
        expect(result2).toEqual(standardResult);
        expect(result3).toEqual(standardResult);

        // CRITICAL: RPC should only be called once
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
        expect(cacheManager.rpcCallCount).toBe(1);
    });

    it("should respect custom TTL duration when provided", async () => {
        vi.useFakeTimers();
        const customTTL = 5000; // 5 seconds
        const customCacheManager = new SimulationCacheManager(customTTL);

        const footprintHash = "custom_ttl_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // First call - cache miss
        await customCacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Advance time by 4 seconds (still within TTL)
        vi.advanceTimersByTime(4000);

        // Second call - cache hit
        await customCacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1); // Still just 1 call

        // Advance time past TTL (total 6 seconds)
        vi.advanceTimersByTime(2000);

        // Third call - cache expired, triggers new RPC
        await customCacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2); // Now 2 calls
    });

    it("should trigger fresh simulation after TTL expires (default 60s)", async () => {
        vi.useFakeTimers();
        const footprintHash = "ttl_expiry_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // First call at T=0
        const result1 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Advance time by 59 seconds (still within default 60s TTL)
        vi.advanceTimersByTime(59_000);

        // Second call - should still be cached
        const result2 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1); // Still cached

        // Advance time by 2 more seconds (total 61s - TTL expired)
        vi.advanceTimersByTime(2_000);

        // Prepare new result for cache refresh
        const freshResult = { ...standardResult, cpuInstructions: 160000 };
        mockSimulationFallback.mockResolvedValueOnce(freshResult);

        // Third call - TTL expired, should trigger new RPC
        const result3 = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        expect(result3.cpuInstructions).toBe(160000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2); // New call made
        expect(cacheManager.rpcCallCount).toBe(2);
    });

    // =========================================================================
    // ACCEPTANCE CRITERION 2: Cache invalidation after successful extension
    // =========================================================================

    it("should invalidate cache entry after explicit invalidation call", async () => {
        const footprintHash = "invalidation_test_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // First call - populate cache
        await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Verify cache is populated
        expect(cacheManager.getCacheSize()).toBe(1);

        // Simulate successful extension - invalidate the cache
        cacheManager.invalidate(footprintHash);

        // Verify cache entry was removed
        expect(cacheManager.getCacheSize()).toBe(0);

        // Next call should trigger fresh RPC (cache miss)
        const freshResult = { ...standardResult, cpuInstructions: 170000 };
        mockSimulationFallback.mockResolvedValueOnce(freshResult);

        const result = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        expect(result.cpuInstructions).toBe(170000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    });

    it("should invalidate only the specified cache entry, not all entries", async () => {
        const footprint1 = "entry_1_footprint";
        const footprint2 = "entry_2_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // Populate cache with two different entries
        await cacheManager.getSimulation(footprint1, wasmHash, instanceId, mockSimulationFallback);
        await cacheManager.getSimulation(footprint2, wasmHash, instanceId, mockSimulationFallback);

        expect(cacheManager.getCacheSize()).toBe(2);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);

        // Invalidate only footprint1
        cacheManager.invalidate(footprint1);

        expect(cacheManager.getCacheSize()).toBe(1);

        // footprint1 should trigger new RPC (invalidated)
        mockSimulationFallback.mockResolvedValueOnce({ ...standardResult, cpuInstructions: 180000 });
        const result1 = await cacheManager.getSimulation(footprint1, wasmHash, instanceId, mockSimulationFallback);
        expect(result1.cpuInstructions).toBe(180000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(3);

        // footprint2 should still be cached (not invalidated)
        const result2 = await cacheManager.getSimulation(footprint2, wasmHash, instanceId, mockSimulationFallback);
        expect(result2).toEqual(standardResult);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(3); // No new call
    });

    it("should handle invalidation of non-existent cache entries gracefully", async () => {
        // Invalidating a non-existent entry should not throw
        expect(() => {
            cacheManager.invalidate("non_existent_footprint");
        }).not.toThrow();

        // Cache should remain empty
        expect(cacheManager.getCacheSize()).toBe(0);
    });

    // =========================================================================
    // EDGE CASES & ERROR HANDLING
    // =========================================================================

    it("should handle concurrent requests within TTL without duplicate RPCs", async () => {
        vi.useFakeTimers();
        const footprintHash = "concurrent_ttl_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        let resolveSimulation: (val: SimulationResult) => void;
        mockSimulationFallback.mockImplementation(() => {
            return new Promise((resolve) => {
                resolveSimulation = resolve;
            });
        });

        // Fire 3 concurrent requests before the first completes
        const promise1 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);
        const promise2 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);
        const promise3 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);

        // Should only trigger one RPC call
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Resolve the simulation
        resolveSimulation!(standardResult);
        await vi.runAllTimersAsync();

        const results = await Promise.all([promise1, promise2, promise3]);
        
        // All should get the same result
        results.forEach(r => expect(r).toEqual(standardResult));
        
        // Still only one RPC call
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
        expect(cacheManager.rpcCallCount).toBe(1);
    });

    it("should handle simulation errors without caching failed results", async () => {
        const footprintHash = "error_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // First call fails
        const error = new Error("Simulation failed: txBadSeq");
        mockSimulationFallback.mockRejectedValueOnce(error);

        await expect(
            cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback)
        ).rejects.toThrow("Simulation failed: txBadSeq");

        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Cache should not contain the failed result
        expect(cacheManager.getCacheSize()).toBe(0);

        // Second call should retry (not pull from cache)
        mockSimulationFallback.mockResolvedValueOnce(standardResult);
        
        const result = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        expect(result).toEqual(standardResult);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    });

    it("should treat different WASM hashes as different cache keys", async () => {
        const footprintHash = "same_footprint";
        const wasmHash1 = "wasm_v1";
        const wasmHash2 = "wasm_v2_upgraded";
        const instanceId = "instance_v1";

        // Call with wasmHash1
        await cacheManager.getSimulation(footprintHash, wasmHash1, instanceId, mockSimulationFallback);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Call with wasmHash2 - should be cache miss (different WASM)
        const result2 = { ...standardResult, cpuInstructions: 200000 };
        mockSimulationFallback.mockResolvedValueOnce(result2);

        const result = await cacheManager.getSimulation(footprintHash, wasmHash2, instanceId, mockSimulationFallback);
        
        expect(result.cpuInstructions).toBe(200000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    });

    it("should treat different instance IDs as different cache keys", async () => {
        const footprintHash = "same_footprint";
        const wasmHash = "wasm_v1";
        const instanceId1 = "instance_v1";
        const instanceId2 = "instance_v2";

        // Call with instanceId1
        await cacheManager.getSimulation(footprintHash, wasmHash, instanceId1, mockSimulationFallback);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Call with instanceId2 - should be cache miss (different instance)
        const result2 = { ...standardResult, cpuInstructions: 210000 };
        mockSimulationFallback.mockResolvedValueOnce(result2);

        const result = await cacheManager.getSimulation(footprintHash, wasmHash, instanceId2, mockSimulationFallback);
        
        expect(result.cpuInstructions).toBe(210000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    });

    // =========================================================================
    // INTEGRATION SCENARIO: Typical daemon cycle behavior
    // =========================================================================

    it("should demonstrate typical daemon cycle: cache hit → extend → invalidate → fresh RPC", async () => {
        vi.useFakeTimers();
        const footprintHash = "daemon_cycle_footprint";
        const wasmHash = "wasm_v1";
        const instanceId = "instance_v1";

        // Cycle 1: First simulation (cache miss)
        const cycle1Result = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(cycle1Result).toEqual(standardResult);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1);

        // Decision: extend threshold reached, simulate again before submit
        // (within same cycle, should be cached)
        const preSubmitSim = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );
        expect(preSubmitSim).toEqual(standardResult);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(1); // Still cached

        // Extension submitted successfully → invalidate cache
        cacheManager.invalidate(footprintHash);
        expect(cacheManager.getCacheSize()).toBe(0);

        // Advance time to next daemon cycle (30 seconds later)
        vi.advanceTimersByTime(30_000);

        // Cycle 2: Check again - cache was invalidated, so fresh RPC
        const freshCycleResult = { ...standardResult, cpuInstructions: 155000 };
        mockSimulationFallback.mockResolvedValueOnce(freshCycleResult);

        const cycle2Result = await cacheManager.getSimulation(
            footprintHash,
            wasmHash,
            instanceId,
            mockSimulationFallback
        );

        expect(cycle2Result.cpuInstructions).toBe(155000);
        expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    });
});
