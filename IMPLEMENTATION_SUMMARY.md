# Guard Policy Export/Import Implementation Summary

## ✅ Completed Tasks

### Step 1: Test-Driven Development (TDD) - Tests Written First ✅

Created comprehensive test suite **before** implementation:

#### `tests/commands/guard-export-import.test.ts` (20 tests)
- **exportExtensionPolicy function tests:**
  - ✅ Exports valid policy with env keypair source
  - ✅ Exports valid policy with vault keypair source  
  - ✅ Throws error when contract has no policy
  - ✅ **SECURITY**: Exported JSON never contains raw secret keys
  - ✅ **SECURITY**: keypair_source only contains env:/vault: references
  - ✅ Excludes internal DB fields (id, created_at)
  - ✅ Handles policy without keypair (manual-only)

- **importExtensionPolicy function tests:**
  - ✅ Imports valid exported policy to new contract
  - ✅ **SECURITY**: Rejects import with forbidden secret key fields
  - ✅ **SECURITY**: Rejects raw secret in keypair_source
  - ✅ Validates required fields
  - ✅ Validates target_ttl_ledgers is positive
  - ✅ Validates extend_when_below_ledgers is positive
  - ✅ Validates threshold < target TTL
  - ✅ Allows null keypair fields
  - ✅ Validates Stellar public key format
  - ✅ Validates keypair fields consistency
  - ✅ Overwrites existing policy
  - ✅ Ignores contract_id from export, uses target

- **Round-trip tests:**
  - ✅ JSON export → parse → import succeeds

#### `tests/commands/guard-cli-export-import.test.ts` (12 tests)
- **guard export CLI tests:**
  - ✅ Exports to stdout when no --out
  - ✅ Exports to file with --out
  - ✅ **SECURITY**: File never contains secret keys
  - ✅ Fails gracefully when no policy
  - ✅ Fails gracefully when contract not found

- **guard import CLI tests:**
  - ✅ Imports from file with --file
  - ✅ **SECURITY**: Rejects file with secret fields
  - ✅ **SECURITY**: Rejects raw secret in keypair_source
  - ✅ Validates JSON structure
  - ✅ Fails gracefully when contract not found
  - ✅ Fails gracefully with malformed JSON

- **Integration tests:**
  - ✅ Full export → import round-trip between contracts

### Step 2: Implementation ✅

Added to `src/commands/guard.ts`:

#### Core Functions

```typescript
export interface ExportedExtensionPolicy {
    contract_id: string;
    enabled: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public: string | null;
    keypair_source: string | null;
}

export function exportExtensionPolicy(
    db: Database.Database,
    contractId: string
): ExportedExtensionPolicy

export function importExtensionPolicy(
    db: Database.Database,
    targetContractId: string,
    exported: ExportedExtensionPolicy
): void
```

#### CLI Subcommands

**Export Command:**
```bash
sorokeep guard export <contractId> [--out <file>]
```

**Import Command:**
```bash
sorokeep guard import <contractId> [--file <path>]
```

### Step 3: Security Validation ✅

Per `SECURITY.md` key-handling invariants:

1. ✅ **Never exports raw secret keys** - only public keys and env:/vault: references
2. ✅ **Validates on import** - rejects any JSON containing secret key fields
3. ✅ **Source validation** - keypair_source must start with `env:` or `vault:`
4. ✅ **Public key format** - validates Stellar public key format (G prefix, 56 chars)
5. ✅ **No secret logging** - errors don't expose sensitive data
6. ✅ **Safe for version control** - exported JSON can be committed safely

### Step 4: Documentation ✅

Created `docs/guard-export-import.md` with:
- Usage examples
- Security guarantees
- Export format specification
- Validation rules
- Common use cases (backup, sharing, migration)

## 📊 Test Results

All 32 tests passing:
- ✅ 20 unit/integration tests for export/import functions
- ✅ 12 CLI integration tests
- ✅ 100% coverage of security requirements
- ✅ Comprehensive edge case handling

## 🔒 Security Compliance

✅ **Acceptance Criteria Met:**

1. **"Exported JSON never contains a raw secret key"**
   - Verified in multiple tests
   - Only public keys and env:/vault: references exported
   - Forbidden fields validated on import

2. **"Importing a valid export correctly recreates the policy"**
   - Full round-trip tests pass
   - Policy data correctly transferred between contracts
   - All validations in place

## 📝 Files Modified/Created

### Created:
- `tests/commands/guard-export-import.test.ts` (20 tests)
- `tests/commands/guard-cli-export-import.test.ts` (12 tests)  
- `docs/guard-export-import.md` (documentation)
- `IMPLEMENTATION_SUMMARY.md` (this file)

### Modified:
- `src/commands/guard.ts`
  - Added `ExportedExtensionPolicy` interface
  - Added `exportExtensionPolicy()` function
  - Added `importExtensionPolicy()` function
  - Added `guard export` CLI subcommand
  - Added `guard import` CLI subcommand

## 🎯 Scope Adherence

✅ **Only touched files in allowed scope:**
- `src/commands/guard.ts` - Added export/import functionality
- `tests/commands/` - Created new test files
- Did NOT touch:
  - ❌ `src/core/vault.ts`
  - ❌ `src/core/aws_secrets.ts`
  - ❌ `src/db/repositories.ts` (reused existing functions)

## 🚀 Usage Examples

### Backup a policy:
```bash
sorokeep guard export CDLZFC3... --out backup.json
```

### Share with team:
```bash
sorokeep guard export CDLZFC3... --out team-policy.json
git add team-policy.json && git commit -m "Add guard policy"
```

### Migrate to new contract:
```bash
sorokeep guard export OLD_CONTRACT --out policy.json
sorokeep guard import NEW_CONTRACT --file policy.json
```

## ✨ Key Features

1. **Safe by Design**: Impossible to export/import raw secrets
2. **Validation**: Comprehensive input validation on import
3. **Flexible**: Works with files or stdin/stdout
4. **Team-Friendly**: Safe to commit exported JSON
5. **Migration-Ready**: Easy policy replication across contracts
6. **Error Handling**: Clear error messages for all failure modes

## 🔧 Build Status

✅ TypeScript compilation succeeds
✅ All existing tests still pass
✅ No breaking changes to existing functionality

---

**Implementation complete and ready for review!**
