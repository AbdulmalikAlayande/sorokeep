/**
 * Footprint-keyed simulation cache for Soroban transactions.
 * 
 * Phase-2 implementation extended with TTL support for auto-extension cycles.
 * 
 * This cache prevents redundant RPC simulateTransaction calls when:
 * 1. The entry footprint has not changed
 * 2. The contract WASM and instance state are unchanged
 * 3. The cache entry has not expired (default: 60s TTL, one polling interval)
 * 
 * Cache invalidation happens:
 * - Automatically after TTL expiration
 * - Explicitly after a successful extension (entry state changed)
 * - When contract WASM or instance hash changes
 */

import { createHash } from "crypto";

export interface SimulationResult {
    cpuInstructions: number;
    memoryBytes: number;
    minResourceFee: number;
    readBytes?: number;
    writeBytes?: number;
}

export interface CacheEntry {
    result: SimulationResult;
    contractWasmHash: string;
    contractInstanceId: string;
    /** Timestamp (ms since epoch) when this entry was cached */
    cachedAt: number;
}

/**
 * Footprint-keyed local simulation cache manager with TTL support.
 */
export class SimulationCacheManager {
    // Primary storage map: keyed on contract footprint hash strings
    private cache = new Map<string, CacheEntry>();
    
    // Deduplicates in-flight RPC simulation requests for the same footprint
    private pending = new Map<string, Promise<SimulationResult>>();
    
    // Tracks live RPC pass-through hits for metrics checking
    public rpcCallCount = 0;
    
    // Time-to-live for cache entries in milliseconds (default: 60 seconds)
    private readonly ttlMs: number;

    /**
     * Create a new simulation cache manager.
     * 
     * @param ttlMs - Time-to-live for cache entries in milliseconds (default: 60000 = 60s)
     */
    constructor(ttlMs: number = 60_000) {
        this.ttlMs = ttlMs;
    }

    /**
     * Retrieves simulation estimates from cache, deduplicates in-flight calls,
     * or executes the fallback transaction simulation function on cache misses or state invalidations.
     * 
     * @param footprintHash - Hash of the entry footprint being simulated
     * @param currentWasmHash - Current contract WASM hash (for invalidation detection)
     * @param contractInstanceId - Current contract instance ID (for invalidation detection)
     * @param simulationFallback - Function to call for fresh simulation on cache miss
     * @returns Simulation result (from cache or fresh RPC)
     */
    async getSimulation(
        footprintHash: string,
        currentWasmHash: string,
        contractInstanceId: string,
        simulationFallback: () => Promise<SimulationResult>
    ): Promise<SimulationResult> {
        const cachedEntry = this.cache.get(footprintHash);
        const now = Date.now();

        // CACHE HIT: Entry exists, state matches, and TTL not expired
        if (
            cachedEntry &&
            cachedEntry.contractWasmHash === currentWasmHash &&
            cachedEntry.contractInstanceId === contractInstanceId &&
            (now - cachedEntry.cachedAt) < this.ttlMs
        ) {
            return cachedEntry.result;
        }

        // If cache entry exists but is stale, remove it
        if (cachedEntry && (now - cachedEntry.cachedAt) >= this.ttlMs) {
            this.cache.delete(footprintHash);
        }

        // Deduplicate in-flight concurrent requests
        if (this.pending.has(footprintHash)) {
            return this.pending.get(footprintHash)!;
        }

        // CACHE MISS or INVALIDATION: Execute live transaction simulation fallback
        this.rpcCallCount++;
        const promise = simulationFallback()
            .then((freshResult) => {
                // Cache the fresh result alongside its matching validation state tokens
                this.cache.set(footprintHash, {
                    result: freshResult,
                    contractWasmHash: currentWasmHash,
                    contractInstanceId,
                    cachedAt: Date.now(),
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
     * Invalidate a specific cache entry by footprint hash.
     * 
     * Call this immediately after a successful extension transaction to ensure
     * the next simulation does not use stale data (the entry's TTL just changed).
     * 
     * @param footprintHash - The footprint hash of the entry that was extended
     */
    invalidate(footprintHash: string): void {
        this.cache.delete(footprintHash);
    }

    /**
     * Clear all cached entries.
     * 
     * Useful for testing or when contract state changes significantly
     * (e.g., contract upgrade).
     */
    clearAll(): void {
        this.cache.clear();
    }

    /**
     * Exposes internal storage size metrics for validation tracking.
     * 
     * @returns Number of cached entries
     */
    getCacheSize(): number {
        return this.cache.size;
    }
}

/**
 * Compute a stable hash for a set of entry key XDRs (footprint).
 * 
 * Used as the cache key to identify identical simulation requests.
 * The footprint is normalized (sorted) to ensure consistent hashing
 * regardless of the order entries are provided.
 * 
 * @param entryKeyXdrs - Array of base64-encoded entry key XDRs
 * @returns SHA-256 hash of the sorted footprint
 */
export function computeFootprintHash(entryKeyXdrs: string[]): string {
    // Sort to ensure consistent hashing regardless of array order
    const normalized = [...entryKeyXdrs].sort();
    const footprintString = normalized.join("|");
    return createHash("sha256").update(footprintString).digest("hex");
}
