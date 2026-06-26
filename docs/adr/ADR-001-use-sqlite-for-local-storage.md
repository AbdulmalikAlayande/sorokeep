# ADR-001: Use SQLite for Local Storage

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Sorokeep needs a local persistence layer to store contract registrations, ledger entry TTLs, alert configurations, extension policies, and cost history. The database must work without any external infrastructure — users should be able to install Sorokeep and start monitoring immediately.

Several database options were considered, spanning embedded and client-server architectures.

## Decision Drivers

- **Zero setup** — Users should not need to install, configure, or maintain a database server
- **Portable** — The database must travel with the tool (single file, no external process)
- **Lightweight** — The data volume is small (hundreds of contracts, not millions of rows)
- **Synchronous API** — The CLI commands are short-lived; an async driver adds complexity for no benefit
- **Testability** — Tests must be fast, isolated, and leave no artifacts

## Considered Options

| Option | Runtime | Setup | Dependencies | Sync API |
|--------|---------|-------|-------------|----------|
| SQLite (better-sqlite3) | Embedded | None | Native addon | Yes |
| PostgreSQL | Client-server | Server + user + password | pg driver | No |
| JSON files | None | None | None | Yes |
| LevelDB | Embedded | None | leveldown | No |

## Decision Outcome

**Chosen option: SQLite via `better-sqlite3`**

Rationale:

1. **Embedded, zero-config** — SQLite runs in-process. No server to install, no ports to configure. The database is a single file (`~/.sorokeep/sorokeep.db`).
2. **Synchronous API** — `better-sqlite3` provides a synchronous JavaScript API. This eliminates callback/async overhead in CLI commands that must complete before the process exits.
3. **WAL mode** — Write-Ahead Logging allows concurrent reads while the daemon writes, without locking contention.
4. **SQL expressiveness** — Joins, aggregations, and constraints are written in SQL rather than application code. The schema is self-documenting (`src/db/schema.sql`).
5. **Battle-tested** — SQLite is the most deployed database engine in the world. It handles power loss, crash recovery, and concurrent access reliably.

### Consequences

- **Positive:** Users can delete the database file to reset state (`rm ~/.sorokeep/sorokeep.db`). No migration tooling needed for single-user setups.
- **Positive:** Tests use `getDatabaseForTesting()` which opens an in-memory SQLite database — fast, isolated, no cleanup needed.
- **Neutral:** Better-sqlite3 requires a native addon compilation. This is handled transparently by `npm install` on supported platforms.
- **Negative:** If Sorokeep adds a web dashboard in the future, the dashboard and daemon cannot share the same database file (SQLite does not support concurrent writers). A client-server database may be introduced for that use case while keeping SQLite for the CLI tool.

## Validation

- Database operations are verified by 100+ tests in `tests/db/` covering CRUD, cascading deletes, upserts, and alert delivery queries.
- All tests use in-memory databases — no filesystem side effects.
