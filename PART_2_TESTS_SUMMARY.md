# PART 2 SUMMARY — TDD Test Suite for Per-Entry-Type Extension Policies

## Overview
Created a comprehensive test suite following TDD principles. All tests are written to **FAIL** until the implementation is complete. Tests will guide the implementation in Parts 3-4.

---

## Test Files Modified

### 1. `tests/db/repositories.test.ts` — Database Layer Tests

**New Test Suite:** `describe("EntryType Extension Policies (per-type overrides)", () => { ... })`

**Location:** Lines 485-644

**Tests (7 total):**

#### Test 1: `getEffectivePolicy returns entry-type override when one exists`
- **Setup:**
  - Create contract "C1"
  - Set contract default policy: target=1000, threshold=500
  - Set instance override: target=2000, threshold=800
- **Call:** `repo.getEffectivePolicy(db, "C1", "instance")`
- **Expected:** Returns {target_ttl_ledgers: 2000, extend_when_below_ledgers: 800}
- **Will FAIL:** Function `getEffectivePolicy` does not exist yet

#### Test 2: `getEffectivePolicy falls back to contract default when no type override`
- **Setup:**
  - Contract default: target=1000, threshold=500
  - NO override for persistent type
- **Call:** `repo.getEffectivePolicy(db, "C1", "persistent")`
- **Expected:** Returns contract default {target_ttl_ledgers: 1000, extend_when_below_ledgers: 500}
- **Will FAIL:** Function does not exist

#### Test 3: `override for one type does not affect other types`
- **Setup:**
  - Contract default: target=1000
  - Instance override: target=2000
- **Call:** `repo.getEffectivePolicy(db, "C1", "wasm")`
- **Expected:** Returns contract default (1000), NOT instance override (2000)
- **Verifies:** Overrides are isolated per entry type

#### Test 4: `getEffectivePolicy returns null when no policy exists at all`
- **Setup:** Contract created but NO policies defined
- **Call:** `repo.getEffectivePolicy(db, "C1", "instance")`
- **Expected:** Returns `null`

#### Test 5: `setEntryTypePolicy creates a new override`
- **Setup:**
  - Contract default: target=1000
  - Call: `repo.setEntryTypePolicy(db, "C1", "wasm", {target_ttl_ledgers: 5000, ...})`
- **Expected:** `getEffectivePolicy(db, "C1", "wasm")` returns {target_ttl_ledgers: 5000}
- **Will FAIL:** Function `setEntryTypePolicy` does not exist

#### Test 6: `setEntryTypePolicy updates existing override (upsert behavior)`
- **Setup:**
  - Create wasm override with target=5000
  - Call `setEntryTypePolicy` again with target=6000
- **Expected:** Returns 6000 (upsert, not insert error)
- **Verifies:** Idempotent update behavior

#### Test 7: `deleting type override restores contract default`
- **Setup:**
  - Create wasm override: target=5000
  - Call: `repo.deleteEntryTypePolicy(db, "C1", "wasm")`
- **Expected:** `getEffectivePolicy(db, "C1", "wasm")` returns contract default (1000)
- **Will FAIL:** Function `deleteEntryTypePolicy` does not exist

---

### 2. `tests/core/extension.test.ts` — Extension Logic Tests

**New Test Suite:** `describe("runAutoExtensions — per-entry-type policy resolution", () => { ... })`

**Location:** Lines 815-1100+ (end of file)

**Tests (6 total):**

#### Test 1: `uses instance override for instance entries`
- **Setup:**
  - Contract default policy: target=1000, threshold=100
  - Instance override: target=2000, threshold=300
  - Instance entry with TTL=500 (below 300 threshold)
  - Mock: submitExtension returns {success: true, txHash: "instance-override-tx"}
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected Behavior:**
  - Entry is extended (below override threshold)
  - Extension is called with instance override (target=2000)
  - Updated entry TTL is 2502100 (consistent with 2000 ledger target)
- **Will FAIL:** `runAutoExtensions` doesn't use per-type policies yet

#### Test 2: `uses persistent override for persistent entries`
- **Setup:**
  - Contract default: target=1000, threshold=100
  - Persistent override: target=500, threshold=50
  - Persistent entry with TTL=75 (below 50 threshold)
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected:** Extension called with persistent override target (500)
- **Will FAIL:** No per-type policy logic

#### Test 3: `falls back to contract default for entry types without override`
- **Setup:**
  - Contract default: target=1000, threshold=100
  - Instance override: target=2000
  - WASM entry (NO override) with TTL=50 (below 100 threshold)
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected:** WASM entry extended to contract default (1000), NOT instance override (2000)
- **Will FAIL:** No fallback logic

#### Test 4: `does not extend entry when type override says extend_when_below is not met`
- **Setup:**
  - Persistent override: target=500, threshold=1000 (HIGH threshold)
  - Persistent entry with TTL=1500 (ABOVE 1000 threshold)
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected:** NO extension called
- **Verifies:** Override thresholds are respected

#### Test 5: `rate limiting applies per-contract not per-policy-row`
- **Setup:**
  - Multiple entry types with different overrides
  - Contract at rate limit (5 extensions already in last hour)
  - Both instance and wasm entries below their thresholds
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected:**
  - NO extensions (rate limit blocks entire contract)
  - Error message contains "rate limit"
  - `mockSubmitExtension` NOT called
- **Verifies:** Rate limiting remains contract-wide (not per-type)

#### Test 6: `instance and wasm entries with different overrides both extended correctly`
- **Setup:**
  - Instance override: target=2000
  - WASM override: target=3000
  - Both entries below their thresholds
  - Mock: submitExtension called twice, returns different targets
- **Call:** `await runAutoExtensions(db, "testnet")`
- **Expected:**
  - Both extended in same transaction
  - Instance entry TTL = 2402100 (target 2000 from base 2400100)
  - WASM entry TTL = 2403100 (target 3000 from base 2400100)
- **Verifies:** Multiple overrides work correctly in single call

---

## Test Framework & Patterns Used

### Testing Infrastructure
- **Framework:** Vitest v3.0.7 (as found in Part 1)
- **Database Setup:** `getDatabaseForTesting()` — creates in-memory SQLite
- **Mocking:** `vi.mock("../../src/rpc/client.js", ...)` — mocks RPC client

### DB Test Pattern (from repositories.test.ts)
```typescript
describe("Database Repositories", () => {
    let db: any;
    
    beforeEach(() => {
        db = getDatabaseForTesting();  // Fresh in-memory DB
    });
    
    afterEach(() => {
        db.close();
    });
    
    it("test case", () => {
        repo.insertContract(db, {...});
        const result = repo.getContract(db, "C1");
        expect(result?.name).toBe("Contract 1");
    });
});
```

### Extension Test Pattern (from extension.test.ts)
```typescript
describe("Core Extension Logic", () => {
    let db: Database.Database;
    const savedEnv: Record<string, string | undefined> = {};
    
    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });
    
    afterEach(() => {
        // Restore env vars
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });
    
    function setEnv(key: string, value: string) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }
    
    it("test case", async () => {
        mockGetCurrentLedger.mockResolvedValue(2400000);
        mockSubmitExtension.mockResolvedValue({success: true, ...});
        
        const result = await runAutoExtensions(db, "testnet");
        
        expect(result.contractsExtended).toBe(1);
    });
});
```

---

## Functions That Will FAIL Until Implemented

### In `src/db/repositories.ts`:

1. **`getEffectivePolicy(db, contractId, entryType): ExtensionPolicy | null`**
   - Returns effective policy for given entry type
   - Looks up type override first
   - Falls back to contract default
   - Returns null if neither exists

2. **`setEntryTypePolicy(db, contractId, entryType, policy): void`**
   - Creates or updates per-entry-type override
   - Takes: contract_id, entry_type ("instance"|"wasm"|"persistent"|"temporary"), policy object
   - Policy object: {target_ttl_ledgers, extend_when_below_ledgers, ...}
   - Upsert behavior (idempotent)

3. **`deleteEntryTypePolicy(db, contractId, entryType): void`**
   - Deletes type override for contract
   - After deletion, getEffectivePolicy falls back to contract default
   - Idempotent (no error if not exists)

### In `src/core/extension.ts`:

4. **Update `runAutoExtensions()` to use per-entry-type policies**
   - For each entry, call `getEffectivePolicy(db, contractId, entry.entry_type)`
   - Use returned policy's threshold/target for that entry
   - Fall back to contract default if no override
   - Rate limiting remains contract-wide

---

## Schema Changes Required

A new table will be needed to store per-entry-type overrides:

```sql
CREATE TABLE IF NOT EXISTS extension_policy_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary')),
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id, entry_type)
);
```

---

## Test Coverage Summary

### Database Layer (7 tests)
- ✓ CRUD operations for per-type overrides
- ✓ Fallback to contract default
- ✓ Isolation between types
- ✓ Null handling
- ✓ Upsert behavior
- ✓ Delete behavior

### Extension Logic Layer (6 tests)
- ✓ Instance override resolution
- ✓ Persistent override resolution
- ✓ Default fallback
- ✓ Threshold enforcement per type
- ✓ Rate limiting remains contract-wide
- ✓ Multiple types extended correctly

### Total: 13 Failing Tests
All tests are designed to fail until implementation is complete.

---

## Running the Tests (Once Dependencies Installed)

```bash
# Run only database tests
npm run test tests/db/repositories.test.ts

# Run only extension tests
npm run test tests/core/extension.test.ts

# Run specific test suite
npm run test -- --grep "per-entry-type policy resolution"

# Run all tests
npm run test
```

---

## Key Test Characteristics

### TDD Principles Applied
1. ✓ Tests written BEFORE implementation
2. ✓ Tests clearly specify expected behavior
3. ✓ All tests will FAIL with current code
4. ✓ Implementation will be guided by test requirements

### Test Quality
1. ✓ Clear setup → action → assertion pattern
2. ✓ Isolated test cases (each tests one thing)
3. ✓ Reusable database setup/teardown
4. ✓ Mocking of external dependencies (RPC client)
5. ✓ Comments explain what each test verifies
6. ✓ Uses exact framework patterns from codebase

### Coverage
- Database CRUD operations
- Policy resolution logic
- Fallback behavior
- Entry type isolation
- Rate limit interactions
- Multiple entry types in same call

---

## Files Modified

1. **`tests/db/repositories.test.ts`**
   - Added: Lines 485-644 (new test suite)
   - No existing tests modified
   - Follows existing test patterns exactly

2. **`tests/core/extension.test.ts`**
   - Added: Lines 815-1100+ (new test suite)
   - No existing tests modified
   - Uses same mock/setup patterns as existing tests

---

## Next Steps (Parts 3-4)

### Part 3: Implement Database Layer
- Create migration: `003_extension_policy_overrides.sql`
- Implement `getEffectivePolicy()`
- Implement `setEntryTypePolicy()`
- Implement `deleteEntryTypePolicy()`
- Tests 1-7 will pass after this

### Part 4: Implement Extension Logic
- Update `runAutoExtensions()` to call `getEffectivePolicy()`
- Apply per-type thresholds to entry filtering
- Tests 8-13 will pass after this

---

END OF PART 2
