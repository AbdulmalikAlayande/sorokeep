
# Contributing to Soroban Sentinel

Sentinel is an open-source project and contributions are welcome. This document explains how the project works, how to set up your environment, and what we expect from contributions.

## Before you start

Read the [README](README.md) to understand what Sentinel does and how it's structured. The short version: Sentinel monitors Soroban smart contract TTLs and alerts developers before their contract state expires. It's a TypeScript CLI that reads from the Stellar RPC and stores data in local SQLite.

If you want to work on something, check the [open issues](https://github.com/AbdulmalikAlayande/soroban-sentinel/issues) first. If there's no issue for what you want to do, open one and describe the change before writing code. This prevents wasted effort on changes that don't fit the project direction.

## Setting up your development environment

You need:

- Node.js 22 or later
- npm
- Git

Clone and install:

```bash
git clone https://github.com/AbdulmalikAlayande/soroban-sentinel.git
cd soroban-sentinel
npm install
```

Verify everything works:

```bash
# Run all tests
npx vitest run

# Run the CLI
npx tsx src/index.ts --help

# Watch a real contract on testnet (optional, requires internet)
npx tsx src/index.ts watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --network testnet --name "XLM Test"
```

If all tests pass and the CLI prints its help screen, you're ready.

## Project structure

```
src/
├── index.ts              # CLI entry point
├── commands/             # CLI command handlers (parse args, call core, format output)
├── core/                 # Business logic (no CLI dependencies, no side effects)
├── rpc/                  # Stellar RPC client wrapper
├── db/                   # SQLite schema, connection, and data access functions
├── alerts/               # Alert dispatcher (webhook, Slack)
├── daemon/               # Monitoring loop and lifecycle
├── logging/              # Structured logging with pino
└── utils/                # Formatting helpers, config loading

tests/                    # Mirrors src/ — same folder names, .test.ts suffix
```

The key architectural rule: **core logic never depends on CLI or presentation code.** The `commands/` layer is a thin wrapper that calls functions from `core/`, which do all the real work. This means the daemon can reuse the same core functions without importing CLI code.

If you're adding a new feature, the logic goes in `core/`, the CLI wiring goes in `commands/`, and tests go in `tests/core/`.

## How we develop

We use test-driven development. The process is:

1. Write the test first. Define what the function should do, what inputs it takes, and what outputs it returns. Run the test — it should fail (red).
2. Write the minimum implementation to make the test pass (green).
3. Refactor if needed, then run all tests to make sure nothing broke.

Every pull request must include tests for new functionality. We don't merge code without tests.

### Running tests

```bash
# All tests
npx vitest run

# Specific file
npx vitest run tests/core/monitor.test.ts

# Watch mode (re-runs on file changes)
npx vitest
```

### Running the CLI during development

Use `tsx` to run TypeScript directly without compiling:

```bash
npx tsx src/index.ts watch <contractId> --network testnet
npx tsx src/index.ts --help
```

### Database

Sentinel uses SQLite stored at `~/.soroban-sentinel/sentinel.db`. The schema is in `src/db/schema.sql`.

Tests use an in-memory SQLite database (`getDatabaseForTesting()`) so they're fast and don't touch your local state.

If you need to reset your local database during development, delete the file:

```bash
# Linux/macOS
rm ~/.soroban-sentinel/sentinel.db

# Windows PowerShell
Remove-Item "$HOME\.soroban-sentinel\sentinel.db"
```

## Code conventions

### TypeScript

- Strict mode is on (`strict: true` in tsconfig)
- `noUncheckedIndexedAccess` is enabled — array access returns `T | undefined`
- ESM modules (`"type": "module"` in package.json)
- Use `import type` for type-only imports
- Error handling: catch errors and return structured results (like `WatchResult`) instead of throwing from core functions. Let the CLI layer decide how to present errors.

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Interfaces/Types: `PascalCase`
- Database columns: `snake_case`
- Constants: `UPPER_SNAKE_CASE` for true constants, `camelCase` for configuration

### Commits

Follow conventional commit format:

```
feat: add slack alert integration
fix: handle archived WASM entries in monitor cycle
test: add boundary tests for TTL threshold detection
docs: update README with daemon usage
refactor: extract RPC response mapping into helper
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`

### Branches

```
feature/short-description
fix/short-description
docs/short-description
```

Branch from `main`, PR back to `main`.

## What makes a good contribution

### Good first issues

If you're new to the project, look for issues tagged `good first issue`. These are typically:

- Adding a new alert channel (email, Discord, Telegram)
- CLI UX improvements (better error messages, colored output)
- Documentation improvements
- Adding test coverage for edge cases

### Larger contributions

For anything beyond small fixes, open an issue first to discuss the approach. This is especially important for:

- New CLI commands
- Database schema changes
- Changes to the monitor cycle logic
- New RPC client methods

### What we look for in PRs

- Tests for new functionality (TDD preferred)
- No unnecessary dependencies — if the standard library or an existing dependency can do it, don't add a new package
- Clear commit messages that explain what and why
- Code that matches the existing style and patterns
- No `console.log` in core logic — use the logger for operational logging, and return data for the CLI layer to print

## Architecture decisions worth knowing

### Why SQLite, not PostgreSQL?

Sentinel runs locally as a CLI tool. SQLite requires zero setup, has no external process, and the database file lives alongside the tool. If we add a web dashboard later, we may introduce a client-server database, but for the core tool, SQLite is the right choice.

### Why Commander.js, not oclif?

Commander is 180KB with zero dependencies. oclif is 12MB with 30+ dependencies. For a CLI that runs quick one-off commands like `sentinel status`, the 85-135ms startup overhead of oclif is noticeable. Commander's API is also simpler for our use case.

### Why a polling daemon, not event-driven?

The Stellar RPC doesn't support WebSocket subscriptions for ledger entry changes. Polling every 5 minutes with `getLedgerEntries` is the only reliable approach. The 5-minute interval is a balance between freshness and RPC load — TTLs are in the tens of thousands of ledgers, so minute-level precision is more than sufficient.

### Why not write contracts in Rust?

Sentinel is an off-chain monitoring tool, not a smart contract. The Stellar JS SDK is the most actively maintained client library for Soroban RPC interactions, and TypeScript maximizes the contributor pool.

## Getting help

If you're stuck or have questions about the codebase, open an issue or reach out on X ([@The_good_man02](https://twitter.com/The_good_man02)). We'd rather answer questions early than review a PR that went in the wrong direction.