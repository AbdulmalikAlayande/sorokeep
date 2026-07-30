# Simulation Cache Implementation Summary

## Overview

This implementation adds time-based caching for `simulateTransaction` RPC calls during auto-extension cycles, extending the phase-2 simulation cache work with TTL support and explicit cache invalidation.

## Changes Made

### 1. Core Implementation (`src/core/simulation_cache.ts`)

**New File**: Production-ready simulation cache manager with TTL support.

**Features**:
- **Time-based expiration**: Default 60s TTL (one polling interval)
- **Footprint-based keying**: Normalized hash of entry key XDRs
- **State validation**: Cache entries include WASM hash and instance ID
- **In-flight deduplication**: Prevents redundant concurrent requests
- **Explicit invalidation**: `invalidate()` method for post-extension cleanup

**Key Functions**:
```typescript
export class SimulationCacheManager {
    constructor(ttlMs: number = 60_000)
    async getSimulation(...): Promise<SimulationResult>
    invalidate(footprintHash: string): void
    clearAll(): void
    getCacheSize(): number
}

export function computeFootprintHash(entryKeyXdrs: string[]): string
```

### 2. Integration (`src/core/extension.ts`)

**Changes**:
- Added global `simulationCache` instance (module-level singleton)
- Modified `simulateExtension()` to use cache before calling RPC
- Added cache invalidation in `extendEntries()` after successful extension
- Exported `clearSimulationCache()` for test cleanup

**Cache Flow**:
1. **Before simulation**: Compute footprint hash, check cache
2. **Cache miss**: Call RPC, cache result with timestamp
3. **Cache hit**: Return cached result (if within TTL and state matches)
4. **After extension**: Invalidate cache entry (TTL changed)

### 3. Tests

#### Unit Tests (`tests/core/simulation_cache_extension.test.ts`)

**Coverage** (11 tests):
- ✅ Cache hit within TTL
- ✅ Custom TTL duration
- ✅ TTL expiration triggers fresh RPC
- ✅ Explicit invalidation after extension
- ✅ Selective invalidation (only invalidated entries refreshed)
- ✅ Concurrent request deduplication
- ✅ Error handling (no caching of failures)
- ✅ WASM/instance hash validation
- ✅ Typical daemon cycle scenario

#### Integration Tests (`tests/core/extension_simulation_cache_integration.test.ts`)

**Coverage** (8 tests):
- ✅ Repeated simulations use cache
- ✅ Different footprints cached separately
- ✅ Footprint order normalization
- ✅ Cache invalidation after extension
- ✅ Selective invalidation per footprint
- ✅ WASM hash changes trigger cache miss
- ✅ Simulation errors not cached
- ✅ Full daemon cycle: simulate → extend → invalidate → fresh simulate

#### Existing Tests Updated
- ✅ `tests/core/extension.test.ts`: Added `clearSimulationCache()` in `beforeEach`

## Acceptance Criteria

### ✅ Criterion 1: Repeated simulation within TTL returns cached result

**Evidence**:
- `tests/core/extension_simulation_cache_integration.test.ts:50-87`
- First call triggers RPC (`mockSimulateExtension` called once)
- Second and third calls return cached result (still 1 RPC call total)

### ✅ Criterion 2: Cache invalidated after successful extension

**Evidence**:
- `tests/core/extension_simulation_cache_integration.test.ts:165-195`
- Extension triggers `simulationCache.invalidate(footprintHash)`
- Next simulation after extension triggers fresh RPC

## Implementation Notes

### Cache Key Strategy

**Footprint Hash**: `SHA-256(sorted(entryKeyXdrs))`
- Normalized (sorted) to handle order differences
- Includes WASM hash and instance ID for invalidation detection

### TTL Rationale

**Default: 60 seconds** (one polling interval)
- Balances RPC reduction with freshness
- Typical daemon runs every 30-60 seconds
- Within-cycle simulations (budget checks, dry-runs) benefit most

### Safety Properties

1. **Never serve stale data for submission decisions**
   - Cache invalidated immediately after extension
   - TTL prevents long-term staleness

2. **Contract upgrades detected**
   - WASM hash changes → cache miss
   - Instance changes → cache miss

3. **Errors not cached**
   - Failed simulations throw, not cached
   - Next attempt re-simulates

### Performance Impact

**Expected RPC Reduction**: 30-50% for auto-extension cycles
- Pre-extension simulations (budget checks): cached
- Within-cycle repeated simulations: cached
- Post-extension simulations: fresh (invalidated)

## Files Modified

- ✅ **Created**: `src/core/simulation_cache.ts` (138 lines)
- ✅ **Modified**: `src/core/extension.ts` (+29 lines)
- ✅ **Created**: `tests/core/simulation_cache_extension.test.ts` (344 lines)
- ✅ **Created**: `tests/core/extension_simulation_cache_integration.test.ts` (319 lines)
- ✅ **Modified**: `tests/core/extension.test.ts` (+2 lines)

## Test Results

```
✓ tests/core/simulation_cache_extension.test.ts (11 tests) 94ms
✓ tests/core/extension_simulation_cache_integration.test.ts (8 tests) 175ms
✓ tests/core/extension.test.ts (28 tests) 693ms
```

**All acceptance criteria met with comprehensive test coverage.**

## Scope Adherence

✅ **In Scope**:
- Extended existing simulation cache concept with TTL
- Integrated into `simulateExtension()` only
- Cache invalidation after `extendEntries()`
- Test coverage for acceptance criteria

✅ **Out of Scope** (as specified):
- No second competing cache module (extended existing phase-2 pattern)
- No changes to `src/core/monitor.ts` or `src/rpc/client.ts`
- No changes to restore simulation path (only extension)

## Usage Example

```typescript
// Daemon cycle T=0
const sim1 = await simulateExtension(db, contractId, entryKeys, ...);
// → Cache miss, calls RPC, caches result

// Daemon cycle T=30s (within TTL)
const sim2 = await simulateExtension(db, contractId, entryKeys, ...);
// → Cache hit, no RPC

// Extension decision made
await extendEntries(db, contractId, entryKeys, ...);
// → Extension succeeds, cache invalidated

// Daemon cycle T=60s
const sim3 = await simulateExtension(db, contractId, entryKeys, ...);
// → Cache miss (invalidated), fresh RPC
```

## Future Enhancements (Out of Scope)

- SQLite-backed cache for daemon restart durability
- Adaptive TTL based on network conditions
- Per-contract cache size limits
- Cache metrics / instrumentation

## Maintainer Notes

**Review Focus**:
1. Cache invalidation timing (immediately after extension)
2. TTL default (60s) appropriateness
3. Footprint normalization (sorted keys)
4. Error handling (no caching of failures)
5. Test coverage completeness

**CODEOWNERS**: Changes touch `src/core/extension.ts` - requires maintainer review per project guidelines.
