import { describe, it, expect, vi, beforeEach } from "vitest";

// ==========================================
// --- 1. CORE IMPLEMENTATION CODE ---
// ==========================================

export interface SimulationResult {
  cpuInstructions: number;
  memoryBytes: number;
  minResourceFee: number;
}

export interface CacheEntry {
  result: SimulationResult;
  contractWasmHash: string;
  contractInstanceId: string;
}

/**
 * Footprint-keyed local simulation cache manager
 */
export class SimulationCacheManager {
  // Primary storage map: keyed on contract footprint hash strings
  private cache = new Map<string, CacheEntry>();
  // Deduplicates in-flight RPC simulation requests for the same footprint
  private pending = new Map<string, Promise<SimulationResult>>();
  public rpcCallCount = 0; // Tracks live RPC pass-through hits for metrics checking

  /**
   * Retrieves simulation estimates from cache, deduplicates in-flight calls,
   * or executes the fallback transaction simulation function on cache misses or state invalidations.
   */
  async getSimulation(
    footprintHash: string,
    currentWasmHash: string,
    contractInstanceId: string,
    simulationFallback: () => Promise<SimulationResult>
  ): Promise<SimulationResult> {
    const cachedEntry = this.cache.get(footprintHash);

    // CRITICAL REQUIREMENT: If cached entry exists AND contract state (WASM + Instance) matches, return it
    if (
      cachedEntry &&
      cachedEntry.contractWasmHash === currentWasmHash &&
      cachedEntry.contractInstanceId === contractInstanceId
    ) {
      return cachedEntry.result;
    }

    // Deduplicate in-flight concurrent requests
    if (this.pending.has(footprintHash)) {
      return this.pending.get(footprintHash)!;
    }

    // Cache Miss or Invalidation: Execute live transaction simulation fallback
    this.rpcCallCount++;
    const promise = simulationFallback()
      .then((freshResult) => {
        // Cache the fresh result alongside its matching validation state tokens
        this.cache.set(footprintHash, {
          result: freshResult,
          contractWasmHash: currentWasmHash,
          contractInstanceId,
        });
        this.pending.delete(footprintHash);
        return freshResult;
      })
      .catch((err) => {
        this.pending.delete(footprintHash);
        throw err;
      });

    this.pending.set(footprintHash, promise);
    return promise;
  }

  /**
   * Exposes internal storage size metrics for validation tracking
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}

// ==========================================
// --- 2. TDD AUTOMATED TEST SUITE ---
// ==========================================

describe("TDD - Local Soroban Transaction Simulation Cache Engine", () => {
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

    // Spy tracking for the simulated RPC network fallback function
    mockSimulationFallback = vi.fn().mockResolvedValue(standardResult);
  });

  it("should return cached resource estimates on duplicate calls with matching footprints", async () => {
    const footprintHash = "footprint_hash_abc_123";
    const wasmHash = "wasm_state_v1";
    const instanceId = "instance_state_v1";

    // First Call: Cache miss, should fire live RPC invocation pass-through
    const run1 = await cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);
    
    // Second Call: Target duplicate footprint hit, should read directly from in-memory cache
    const run2 = await cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);

    // Assert: Verify results match perfectly
    expect(run1).toEqual(standardResult);
    expect(run2).toEqual(standardResult);
    
    // CRITICAL CRITERIA ASSERTION: Confirm network traffic did not duplicate
    expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
    expect(cacheManager.rpcCallCount).toBe(1);
  });

  it("should invalidate cache and trigger a fresh simulation when footprints, WASMs, or instances modify", async () => {
    const footprintHash = "footprint_hash_abc_123";
    const initialWasmHash = "wasm_state_v1";
    const upgradedWasmHash = "wasm_state_v2_upgraded";
    const instanceId = "instance_state_v1";
    const upgradedInstanceId = "instance_state_v2_upgraded";

    // Step 1: Prime cache repository tracking metrics
    await cacheManager.getSimulation(footprintHash, initialWasmHash, instanceId, mockSimulationFallback);
    expect(cacheManager.rpcCallCount).toBe(1);

    // Step 2: Simulate another transaction layout execution pass targeting an updated contract WASM state
    const upgradedWasmResult: SimulationResult = { ...standardResult, cpuInstructions: 280000 };
    mockSimulationFallback.mockResolvedValueOnce(upgradedWasmResult);

    const runWithInvalidatedWasm = await cacheManager.getSimulation(
      footprintHash,
      upgradedWasmHash, // State signature mismatch triggers invalidation path
      instanceId,
      mockSimulationFallback
    );

    expect(runWithInvalidatedWasm.cpuInstructions).toBe(280000);
    expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    expect(cacheManager.rpcCallCount).toBe(2);

    // Step 3: Simulate targeting an updated contract instance state
    const upgradedInstanceResult: SimulationResult = { ...standardResult, cpuInstructions: 320000 };
    mockSimulationFallback.mockResolvedValueOnce(upgradedInstanceResult);

    const runWithInvalidatedInstance = await cacheManager.getSimulation(
      footprintHash,
      upgradedWasmHash,
      upgradedInstanceId, // Instance signature mismatch triggers invalidation path
      mockSimulationFallback
    );

    expect(runWithInvalidatedInstance.cpuInstructions).toBe(320000);
    expect(mockSimulationFallback).toHaveBeenCalledTimes(3);
    expect(cacheManager.rpcCallCount).toBe(3);
  });

  it("should deduplicate in-flight concurrent requests for the same footprint", async () => {
    const footprintHash = "footprint_hash_concurrent";
    const wasmHash = "wasm_state_v1";
    const instanceId = "instance_state_v1";

    let resolveSimulation: (val: SimulationResult) => void;
    mockSimulationFallback.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveSimulation = resolve;
      });
    });

    const promise1 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);
    const promise2 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);
    const promise3 = cacheManager.getSimulation(footprintHash, wasmHash, instanceId, mockSimulationFallback);

    expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
    expect(cacheManager.rpcCallCount).toBe(1);

    // Resolve the single shared pending promise
    resolveSimulation!(standardResult);

    const results = await Promise.all([promise1, promise2, promise3]);
    for (const result of results) {
      expect(result).toEqual(standardResult);
    }
    
    // Should still only have one RPC call made
    expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
  });
});