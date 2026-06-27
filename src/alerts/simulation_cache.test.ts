import { describe, it, expect, vi, beforeEach } from "vitest";

// ==========================================
// --- 1. CORE IMPLEMENTATION CODE ---
// ==========================================

export interface SimulationResult {
  cpuInstructions: number;
  memBytes: number;
  minResourceFee: string;
}

export interface CacheEntry {
  result: SimulationResult;
  contractWasmHash: string;
}

/**
 * Footprint-keyed local simulation cache manager
 */
export class SimulationCacheManager {
  // Primary storage map: keyed on contract footprint hash strings
  private cache = new Map<string, CacheEntry>();
  public rpcCallCount = 0; // Tracks live RPC pass-through hits for metrics checking

  /**
   * Retrieves simulation estimates from cache, or executes the fallback transaction 
   * simulation function on cache misses or state invalidations.
   */
  async getSimulation(
    footprintHash: string,
    currentWasmHash: string,
    simulationFallback: () => Promise<SimulationResult>
  ): Promise<SimulationResult> {
    const cachedEntry = this.cache.get(footprintHash);

    // CRITICAL REQUIREMENT: If cached entry exists AND contract state matches, return it
    if (cachedEntry && cachedEntry.contractWasmHash === currentWasmHash) {
      return cachedEntry.result;
    }

    // Cache Miss or Invalidation: Execute live transaction simulation fallback
    this.rpcCallCount++;
    const freshResult = await simulationFallback();

    // Cache the fresh result alongside its matching validation state token
    this.cache.set(footprintHash, {
      result: freshResult,
      contractWasmHash: currentWasmHash,
    });

    return freshResult;
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
      memBytes: 4096,
      minResourceFee: "10000",
    };

    // Spy tracking for the simulated RPC network fallback function
    mockSimulationFallback = vi.fn().mockResolvedValue(standardResult);
  });

  it("should return cached resource estimates on duplicate calls with matching footprints", async () => {
    const footprintHash = "footprint_hash_abc_123";
    const wasmHash = "wasm_state_v1";

    // First Call: Cache miss, should fire live RPC invocation pass-through
    const run1 = await cacheManager.getSimulation(footprintHash, wasmHash, mockSimulationFallback);
    
    // Second Call: Target duplicate footprint hit, should read directly from in-memory cache
    const run2 = await cacheManager.getSimulation(footprintHash, wasmHash, mockSimulationFallback);

    // Assert: Verify results match perfectly
    expect(run1).toEqual(standardResult);
    expect(run2).toEqual(standardResult);
    
    // CRITICAL CRITERIA ASSERTION: Confirm network traffic did not duplicate
    expect(mockSimulationFallback).toHaveBeenCalledTimes(1);
    expect(cacheManager.rpcCallCount).toBe(1);
  });

  it("should invalidate cache and trigger a fresh simulation when footprints or contract WASMs modify", async () => {
    const footprintHash = "footprint_hash_abc_123";
    const initialWasmHash = "wasm_state_v1";
    const upgradedWasmHash = "wasm_state_v2_upgraded";

    // Step 1: Prime cache repository tracking metrics
    await cacheManager.getSimulation(footprintHash, initialWasmHash, mockSimulationFallback);
    expect(cacheManager.rpcCallCount).toBe(1);

    // Step 2: Simulate another transaction layout execution pass targeting an updated contract state
    const upgradedResult: SimulationResult = { ...standardResult, cpuInstructions: 280000 };
    mockSimulationFallback.mockResolvedValueOnce(upgradedResult);

    const runWithInvalidatedState = await cacheManager.getSimulation(
      footprintHash,
      upgradedWasmHash, // State signature mismatch triggers invalidation path
      mockSimulationFallback
    );

    // Assert: Check that fresh structural parameters were registered
    expect(runWithInvalidatedState.cpuInstructions).toBe(280000);
    
    // CRITICAL INVALIDATION ASSERTION: Verify fallback ran again to fetch un-cached parameters
    expect(mockSimulationFallback).toHaveBeenCalledTimes(2);
    expect(cacheManager.rpcCallCount).toBe(2);
  });
});