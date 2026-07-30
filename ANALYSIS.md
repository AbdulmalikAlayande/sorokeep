# GitHub Issue #491 Analysis — Per-Entry-Type Extension Policies

## PART 1: READ-ONLY ANALYSIS REPORT

### 1. EXTENSION.TS — Complete Analysis

#### File: `src/core/extension.ts`

**Rate Limiting Section:**
```typescript
export const HOURLY_RATE_LIMIT = 5;

export function isRateLimited(
    db: import("better-sqlite3").Database,
    contractId: string,
    limit = HOURLY_RATE_LIMIT,
): boolean {
    const count = countExtensionsInLastHour(db, contractId);
    return count >= limit;
}
```
- Limits auto-extensions to 5 transactions per contract per hour
- Uses `countExtensionsInLastHour()` to query extension history in last 60 minutes
- Rate limit check happens ONCE per contract in `runAutoExtensions()`

**Complete runAutoExtensions() Function:**
- Filters contracts by network AND enabled policy
- Gets current ledger from RPC client
- Sets up optional channel account pool for funded accounts
- For each eligible contract:
  1. Retrieves extension policy
  2. Filters entries needing extension (TTL below threshold)
  3. **Rate limit check**: blocks if >= HOURLY_RATE_LIMIT
  4. Resolves secret key (channel pool > policy keypair_source)
  5. **Calls simulateExtension()** if budget exists
  6. **Calls extendEntries()** (only instance/wasm keys supported)
  7. Records extension history and updates entry TTLs
  8. Tracks anomalies (resource usage 2x baseline)

**Entry Type Handling in runAutoExtensions():**
- Line ~180: `const entryKeys = needsExtension.map(e => e.entry_key_xdr);`
- **Currently extends ALL entry types without filtering**
- No per-entry-type policies enforced
- SDK calls treat all keys the same

**How getExtensionPolicy() is Called:**
- Called once per contract at line ~145: `const policy = getExtensionPolicy(db, contract.id)!;`
- Returns single policy object for entire contract
- ExtensionPolicy interface has NO entry-type field

**TypeScript Interfaces Used:**
```typescript
interface ExtensionResult {
    success: boolean;
    contractId: string;
    entriesExtended: number;
    txHash?: string;
    ledger?: number;
    error?: string;
    estimatedFee?: number;
    feeCharged?: number;
    cpuInsns?: number;
    memBytes?: number;
    readBytes?: number;
    writeBytes?: number;
    isAnomaly?: boolean;
    anomalyDetails?: string;
}

interface AutoExtensionResult {
    contractsChecked: number;
    contractsExtended: number;
    entriesExtended: number;
    errors: string[];
    extensions: Array<{
        contractId: string;
        txHash: string;
        entriesExtended: number;
        ledger: number;
        isAnomaly?: boolean;
        anomalyDetails?: string;
    }>;
}
```

**SDK Calls for Extension:**
- `client.simulateExtension(entryKeyXdrs, extendToLedgers, sourcePublicKey)`
- `client.submitExtension(entryKeyXdrs, extendToLedgers, secretKey)`
- `client.submitExtensionWithFeeBump(...)` (for fee bump)
- `client.getEntryTTLs(entryKeyXdrs)` — fetches updated TTLs after submission

**Other Key Functions:**
- `simulateExtension()` — returns ExtensionResult with fee estimates
- `extendEntries()` — performs actual extension, records history, detects anomalies
- `resolveSecretKey()` — resolves from env:, vault:, or direct string
- `isRateLimited()` — checks extension count in last hour

---

### 2. REPOSITORIES.TS — Complete Analysis

#### File: `src/db/repositories.ts` (1330 lines total)

**ExtensionPolicy Interface:**
```typescript
export interface ExtensionPolicy {
    id: number;
    contract_id: string;
    enabled: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public: string | null;
    keypair_source: string | null;
    created_at: Date;
}
```
- **NO entry_type field** — policies are contract-wide only
- Schema enforces UNIQUE(contract_id)

**ContractEntry Interface:**
```typescript
export interface ContractEntry {
    id: number;
    contract_id: string;
    entry_key_xdr: string;
    entry_type: "instance" | "wasm" | "persistent" | "temporary";
    label: string | null;
    live_until_ledger: number;
    last_modified_ledger: number;
    discovery_source: "deterministic" | "manual" | "instance_scan" | "footprint" | "introspection";
    first_seen_at: Date;
    last_checked_at: Date | null;
}
```

**Complete getExtensionPolicy() Function:**
```typescript
export function getExtensionPolicy(db: Database.Database, contractId: string): ExtensionPolicy | undefined {
  return db.prepare("SELECT * FROM extension_policies WHERE contract_id = ?").get(contractId) as ExtensionPolicy | undefined;
}
```
- Simple SELECT by contract_id
- No filtering by entry_type
- Returns single policy object

**upsertExtensionPolicy() Function:**
```typescript
export function upsertExtensionPolicy(db: Database.Database, policy: {
  contract_id: string;
  enabled?: boolean;
  target_ttl_ledgers: number;
  extend_when_below_ledgers: number;
  keypair_public?: string;
  keypair_source?: string;
}): void {
  db.prepare(`
    INSERT INTO extension_policies (contract_id, enabled, target_ttl_ledgers, extend_when_below_ledgers, keypair_public, keypair_source)
    VALUES (@contract_id, @enabled, @target_ttl_ledgers, @extend_when_below_ledgers, @keypair_public, @keypair_source)
    ON CONFLICT(contract_id) DO UPDATE SET
      enabled = @enabled,
      target_ttl_ledgers = @target_ttl_ledgers,
      extend_when_below_ledgers = @extend_when_below_ledgers,
      keypair_public = @keypair_public,
      keypair_source = @keypair_source
  `).run({
    contract_id: policy.contract_id,
    enabled: policy.enabled !== false ? 1 : 0,
    target_ttl_ledgers: policy.target_ttl_ledgers,
    extend_when_below_ledgers: policy.extend_when_below_ledgers,
    keypair_public: policy.keypair_public ?? null,
    keypair_source: policy.keypair_source ?? null,
  });
}
```
- ON CONFLICT replaces entire row
- No entry_type handling

**Other Policy-Related Functions:**
- None found — only getExtensionPolicy() and upsertExtensionPolicy()

**Database Access Library:**
- `better-sqlite3` version `^12.9.0` (synchronous SQLite)
- Uses `.prepare().run()`, `.prepare().get()`, `.prepare().all()` pattern
- Transactions via `db.transaction()`

**extension_policies Table Schema:**
```sql
CREATE TABLE IF NOT EXISTS extension_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT 0,
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    keypair_public TEXT,
    keypair_source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id)
);
```
- **Column names match interface exactly**
- UNIQUE constraint on contract_id (one policy per contract)
- No entry_type column

---

### 3. GUARD.TS — Complete Analysis

#### File: `src/commands/guard.ts`

**Command Framework:**
- Uses `commander` v14.0.3
- Function: `registerGuardCommand(program: Command): void`
- Command: `guard <contractId>`

**CLI Flags/Options:**
```typescript
.option("--target-ttl <ledgers>", "Target TTL in ledgers after extension", "100000")
.option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers", "20000")
.option("--keypair <secret>", "Stellar secret key for signing extension transactions")
.option("--keypair-env <var>", "Environment variable containing the secret key")
.option("--keypair-vault <path>", "HashiCorp Vault secret path (e.g. secret/data/stellar/mykey)")
.option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
.option("--dry-run", "Simulate the extension without submitting")
.option("--disable", "Disable auto-extension for this contract")
```
- **NO entry-type flags** — cannot configure per-entry-type policies
- Options are parsed into `options` object

**How --contract-id and Flags are Parsed:**
```typescript
.command("guard <contractId>")
.action(async (contractId: string, options) => {
    const targetTTL = parseInt(options.targetTtl, 10);
    const threshold = parseInt(options.threshold, 10);
    // ... validation ...
```
- contractId as positional argument
- Options passed as second parameter to action handler
- Commander handles parsing and validation

**How guard Command Calls runAutoExtensions:**
- Line ~145: `const result = await simulateExtension(...)`
- Line ~160: `const result = await extendEntries(...)`
- **Does NOT call runAutoExtensions** — runAutoExtensions is called by daemon
- guard.ts is for manual one-time extensions or policy setup
- runAutoExtensions() is called from daemon.ts for auto-extension loop

**Key Flow in guard.ts:**
1. Parse --contract-id
2. Get contract from DB
3. Parse numeric options (target-ttl, threshold)
4. If --disable: disable policy and exit
5. If --auto-extend: save policy, resolve keypair source
6. If --dry-run: call simulateExtension and show results
7. If --keypair/--keypair-env/--keypair-vault: call extendEntries for one-time extension
8. Otherwise: show current policy

---

### 4. MIGRATION FILES

#### Location: `src/db/migrations/`
- **Naming Convention:** `{NNN}_{description}.sql` (zero-padded, sequential)
- **Existing File:** `001_resource_usage_logs.sql`
- **Pattern:** 
  - Header comment with migration number and issue reference
  - Pure SQL (no TypeScript)
  - CREATE TABLE IF NOT EXISTS (idempotent)
  - CREATE INDEX IF NOT EXISTS
  - Migrations are applied via migrator.js at startup
  - No down() pattern — migrations are one-way

**Structure of 001_resource_usage_logs.sql:**
```sql
-- Migration 001: add resource_usage_logs table (issue #164)
--
-- Stores per-transaction CPU, memory, and fee-parameter snapshots...

CREATE TABLE IF NOT EXISTS resource_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    ...
);

CREATE INDEX IF NOT EXISTS idx_resource_usage_logs_contract_id
    ON resource_usage_logs(contract_id);
```

---

### 5. TEST FILES & FRAMEWORK

#### Tests Exist: YES
- `tests/core/extension.test.ts` — ✓ EXISTS (extension logic tests)
- `tests/db/repositories.test.ts` — ✓ EXISTS (database function tests)

**Test Framework:**
- `vitest` v3.0.7 (replace for jest)
- Uses `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi` (mocking)
- Database testing uses `getDatabaseForTesting()` — in-memory SQLite
- Mocking: `vi.mock()` for external modules (RPC client, etc.)

**extension.test.ts Structure:**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";

// Mocks
vi.mock("../../src/rpc/client.js", () => ({
    StellarRpcClient: class MockStellarRpcClient { ... }
}));

// Import after mocking
const { extendEntries, runAutoExtensions, ... } = await import("../../src/core/extension.js");

// Helper functions
function seedContract(db, overrides?) { ... }

// Test suite
describe("Core Extension Logic", () => {
    let db;
    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });
    afterEach(() => {
        db.close();
    });
    
    it("test case", () => { ... });
});
```

**repositories.test.ts Structure:**
```typescript
describe("Database Repositories", () => {
    let db: any;

    beforeEach(() => {
        db = getDatabaseForTesting();  // Fresh in-memory DB
    });

    afterEach(() => {
        db.close();
    });

    describe("ExtensionPolicy CRUD", () => {
        it("upserts and gets policy", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
                keypair_public: "PUB",
                keypair_source: "SRC"
            });
            
            let p = repo.getExtensionPolicy(db, "C1");
            expect(p?.target_ttl_ledgers).toBe(10000);
        });
    });
});
```

---

### 6. PACKAGE.JSON

**Test Runner:**
- `vitest` v3.0.7 (test runner)
- Scripts:
  - `npm run test` — `vitest run` (single run)
  - `npm run test:watch` — `vitest` (watch mode)
  - `npm run test:e2e` — `vitest run tests/e2e`

**Database Library:**
- `better-sqlite3` v12.9.0 (synchronous)

**Command Framework:**
- `commander` v14.0.3

**Build Command:**
- `npm run build` — compiles TypeScript + copies migrations to dist/

---

### 7. ENTRY TYPE DEFINITION

**EntryType is a Union Type (NOT an enum):**
```typescript
type EntryType = "instance" | "wasm" | "persistent" | "temporary";
```

**Found in multiple places:**
- `ContractEntry.entry_type: "instance" | "wasm" | "persistent" | "temporary"`
- `contract_entries` table CHECK constraint
- Schema validation: `CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary'))`
- Database prevents invalid types at insert/update time

**Current Handling:**
- All entry types can be queried and stored
- But **only instance and wasm entries have TTLs** (persistent/temporary do not expire)
- Extension logic currently processes all 4 types (though only instance/wasm matter)

---

## KEY FINDINGS SUMMARY

### Current State
1. **One policy per contract** — ExtensionPolicy has no entry_type field
2. **Rate limiting is contract-wide** — one 5-per-hour limit for entire contract
3. **All entry types extended together** — no per-type thresholds/targets
4. **Guard command has no entry-type flags** — cannot configure per-type policies

### Database Schema
- `extension_policies` table is simple (7 columns, contract_id is unique key)
- `contract_entries` table has entry_type field (4 values)
- No junction table or per-type policy records

### Extension Logic
- `runAutoExtensions()` filters entries by single policy
- No logic to apply different thresholds/targets per entry type
- Rate limit check happens once per contract

### Code Patterns
- Better-sqlite3 with `.prepare().run()` pattern
- Vitest for testing
- In-memory DB (`:memory:`) for tests via `getDatabaseForTesting()`
- Transactions via `db.transaction()`
- Migration files in `src/db/migrations/` with zero-padded naming

---

## ISSUE #491 IMPLEMENTATION PLAN (High Level)

To implement per-entry-type extension policies:

1. **Schema Migration**: Create new per-type policy table or extend existing
2. **New Repository Functions**: CRUD for per-type policies
3. **Update Guard Command**: Add --entry-type flag to configure per-type settings
4. **Update Extension Logic**: Filter entries and apply per-type thresholds
5. **Update Rate Limiting**: Per-type rate limits (optional)
6. **Tests**: Add test coverage for new per-type policy logic

---

END OF ANALYSIS
