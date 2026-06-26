# ADR-006: In-Memory SQLite for Testing

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Sorokeep's tests need a database to verify CRUD operations, cascading deletes, alert lifecycle, extension policies, and integration between components. The test database must be fast, isolated per test case, and leave no artifacts on the filesystem.

Using the production database path (`~/.sorokeep/sorokeep.db`) for tests is not acceptable — tests would clobber the user's real data.

## Decision Drivers

- **Isolation** — Each test case (or at least each `describe` block) should start with a clean database
- **Speed** — Tests run in CI and during development; slow database setup hurts iteration time
- **Cleanup** — No test should leave files on disk after completion
- **Parity** — The test database must use the same SQLite engine as production to avoid false positives
- **Parallelism** — Tests should be able to run in parallel without database file contention

## Considered Options

| Option | Isolation | Speed | Cleanup | Production Parity |
|--------|-----------|-------|---------|-------------------|
| In-memory SQLite (`:memory:`) | Perfect | Fastest | Automatic | Full |
| Temporary file SQLite | Good | Fast | Manual deletion | Full |
| Mock database layer | Partial | Fast | Automatic | None |

## Decision Outcome

**Chosen option: In-memory SQLite via `getDatabaseForTesting()`**

`getDatabaseForTesting()` opens a `better-sqlite3` connection to `:memory:`, initializes the schema, enables WAL mode, and returns the database handle. Each call produces an independent, empty database.

```typescript
import { getDatabaseForTesting } from "../../src/db/database";

let db: Database.Database;

beforeEach(() => {
    db = getDatabaseForTesting();
});
```

Rationale:

1. **Complete isolation** — Each `beforeEach` creates a fresh in-memory database. No state leaks between tests. No cleanup needed.
2. **Maximum speed** — In-memory databases have no I/O latency. Schema initialization takes ~2ms. A test suite with 500+ operations completes in under a second.
3. **Zero cleanup** — When the database connection closes (garbage collected or process exit), the memory is reclaimed. No temp files, no `afterAll` cleanup hooks.
4. **Identical engine** — The same `better-sqlite3` driver, same schema, same SQL. Tests are a reliable proxy for production behavior.
5. **Parallel-safe** — Each test creates its own `:memory:` connection. There is no shared state. Vitest's parallel test execution works without modification.

### Consequences

- **Positive:** Developers can run the full test suite without affecting their local Sorokeep database.
- **Positive:** CI does not need to clean up database files between runs.
- **Positive:** Tests are truly hermetic — they can be reordered, parallelized, or run individually without flakiness.
- **Negative:** Tests cannot verify file-level behaviors (database file permissions, WAL file cleanup, etc.). These are covered by a small number of integration tests in `tests/utils/config.test.ts`.
- **Negative:** In-memory databases are not shared across processes. This would prevent cross-process test scenarios, but Sorokeep is single-process by design.

## Validation

- All 14 test files (238+ tests) use `getDatabaseForTesting()` exclusively.
- No test file writes to or reads from the production database path.
- TypeScript ensures `getDatabaseForTesting` is only imported in test files (it is not exported from `src/db/database.ts` for production use).
