# Contributing to Sorokeep

Sorokeep is an open-source project and contributions are welcome. This document explains how the project works, how to set up your environment, and what we expect from contributions.

## Table of Contents

- [Before You Start](#before-you-start)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
  - [Test-Driven Development](#test-driven-development)
  - [Running Tests](#running-tests)
  - [Running the CLI During Development](#running-the-cli-during-development)
  - [Database](#database)
  - [Linting and Type Checking](#linting-and-type-checking)
- [Code Conventions](#code-conventions)
  - [TypeScript](#typescript)
  - [Naming](#naming)
  - [Imports](#imports)
  - [Error Handling](#error-handling)
  - [Commits](#commits)
  - [Branches](#branches)
- [Architecture Decision Records](#architecture-decision-records)
- [E2E Sandbox Testing](#e2e-sandbox-testing)
- [What Makes a Good Contribution](#what-makes-a-good-contribution)
  - [Good First Issues](#good-first-issues)
  - [Larger Contributions](#larger-contributions)
  - [PR Checklist](#pr-checklist)
- [Getting Help](#getting-help)

## Before You Start

Read the [README](README.md) to understand what Sorokeep does and how it's structured. The short version: Sorokeep monitors Soroban smart contract TTLs and alerts developers before their contract state expires. It's a TypeScript CLI that reads from the Stellar RPC and stores data in local SQLite.

If you want to work on something, check the [open issues](https://github.com/AbdulmalikAlayande/sorokeep/issues) first. If there's no issue for what you want to do, open one and describe the change before writing code. This prevents wasted effort on changes that don't fit the project direction.

## Quick Start

You need:

- Node.js 22 or later
- npm
- Git

Clone and install:

```bash
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
```

Verify everything works:

```bash
# Run all tests
npm test

# Run the CLI
npx tsx src/index.ts --help

# Watch a real contract on testnet (optional, requires internet)
npx tsx src/index.ts watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --network testnet --name "XLM Test"
```

If all tests pass and the CLI prints its help screen, you're ready.

## Project Structure

```
sorokeep/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── commands/             # CLI command handlers (parse args, call core, format output)
│   ├── core/                 # Business logic (no CLI dependencies, no side effects)
│   ├── rpc/                  # Stellar RPC client wrapper
│   ├── db/                   # SQLite schema, connection, and data access functions
│   ├── alerts/               # Alert dispatcher (webhook, Slack)
│   ├── daemon/               # Monitoring loop and lifecycle
│   ├── logging/              # Structured logging with pino
│   └── utils/                # Formatting helpers, config loading
├── tests/                    # Mirrors src/ — same folder names, .test.ts suffix
│   ├── commands/
│   ├── core/
│   ├── alerts/
│   ├── daemon/
│   ├── rpc/
│   ├── db/
│   └── utils/
├── docs/                     # Documentation
│   ├── adr/                  # Architecture Decision Records
│   └── e2e-sandbox.md        # E2E sandbox setup guide
├── .github/workflows/        # CI (test + type-check) and publish
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── CONTRIBUTING.md
```

**Key architectural rule:** core logic never depends on CLI or presentation code. The `commands/` layer is a thin wrapper that calls functions from `core/`, which do all the real work. This means the daemon can reuse the same core functions without importing CLI code.

If you're adding a new feature, the logic goes in `core/`, the CLI wiring goes in `commands/`, and tests go in `tests/core/`.

## Development Workflow

### Test-Driven Development

We enforce strict test-driven development. Your PR will not be accepted without comprehensive tests.

The process is:

1. **Write the test first.** Define what the function should do, what inputs it takes, and what outputs it returns. Run the test — it should fail (red).
2. **Write the minimum implementation** to make the test pass (green).
3. **Refactor if needed**, then run all tests to make sure nothing broke.

### Running Tests

```bash
# All tests
npm test

# Specific file
npx vitest run tests/core/monitor.test.ts

# Watch mode (re-runs on file changes)
npx vitest

# With coverage
npx vitest run --coverage
```

All tests use in-memory SQLite databases and mocked RPC responses — no network calls, no filesystem side effects.

### Running the CLI During Development

Use `tsx` to run TypeScript directly without compiling:

```bash
npx tsx src/index.ts watch <contractId> --network testnet
npx tsx src/index.ts --help
```

### Database

Sorokeep uses SQLite stored at `~/.sorokeep/sorokeep.db`. The schema is in `src/db/schema.sql`.

Tests use an in-memory SQLite database (`getDatabaseForTesting()`) so they're fast and don't touch your local state.

If you need to reset your local database during development:

```bash
# Linux/macOS
rm ~/.sorokeep/sorokeep.db

# Windows PowerShell
Remove-Item "$HOME\.sorokeep\sorokeep.db"
```

### Linting and Type Checking

```bash
# Lint
npm run lint

# Type check (without emitting files)
npx tsc --noEmit
```

Run both before pushing to ensure CI passes.

## Code Conventions

### TypeScript

- Strict mode is on (`strict: true` in tsconfig)
- `noUncheckedIndexedAccess` is enabled — array access returns `T | undefined`
- ESM modules (`"type": "module"` in package.json). See [ADR-002](docs/adr/ADR-002-use-esm-modules.md).
- Use `import type` for type-only imports
- No `console.log` in core logic — use the pino logger for operational logging, and return data for the CLI layer to print

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Interfaces/Types: `PascalCase`
- Database columns: `snake_case`
- Constants: `UPPER_SNAKE_CASE` for true constants, `camelCase` for configuration

### Imports

Order imports by:
1. Node.js built-ins (`node:fs`, `node:path`)
2. Third-party packages (`vitest`, `better-sqlite3`, `commander`)
3. Internal modules (`../../src/core/monitor.js`)

Use explicit `.js` extensions for internal imports (ESM requirement). Type-only imports use `import type`.

### Error Handling

Catch errors and return structured results (like `WatchResult`) instead of throwing from core functions. Let the CLI layer decide how to present errors.

```typescript
// Core function returns a result type, doesn't throw
function doSomething(input: string): { ok: true; value: number } | { ok: false; error: string }
```

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

## Architecture Decision Records

Significant design decisions are documented as Architecture Decision Records (ADRs) in [docs/adr/](docs/adr/). Each ADR explains the context, options considered, and rationale for the chosen approach.

| ADR | Title | Description |
|-----|-------|-------------|
| [ADR-001](docs/adr/ADR-001-use-sqlite-for-local-storage.md) | Use SQLite for Local Storage | Why SQLite over PostgreSQL or JSON files |
| [ADR-002](docs/adr/ADR-002-use-esm-modules.md) | Use ESM (ECMAScript Modules) | Why ESM over CommonJS |
| [ADR-003](docs/adr/ADR-003-use-commander-js-for-cli.md) | Use Commander.js for CLI Framework | Why Commander over oclif or yargs |
| [ADR-004](docs/adr/ADR-004-polling-daemon-architecture.md) | Polling Daemon Architecture | Why polling over event-driven |
| [ADR-005](docs/adr/ADR-005-use-typescript-over-rust.md) | Use TypeScript (Not Rust) | Why TypeScript over Rust for this tool |
| [ADR-006](docs/adr/ADR-006-in-memory-sqlite-for-testing.md) | In-Memory SQLite for Testing | Why tests use in-memory databases |

Before making a significant new design decision, write an ADR. This helps future contributors understand why things are the way they are.

## E2E Sandbox Testing

We provide a complete guide for setting up an end-to-end sandbox environment with a local Stellar network using Docker. See [docs/e2e-sandbox.md](docs/e2e-sandbox.md) for:

- Running a local Soroban-enabled Stellar network
- Creating and funding test accounts
- Deploying test contracts
- Configuring Sorokeep to monitor local contracts
- An automated E2E test script for CI usage
- Troubleshooting common issues

The sandbox lets you test Sorokeep against a real Stellar RPC without touching public testnet or mainnet.

## What Makes a Good Contribution

### Good First Issues

If you're new to the project, look for issues tagged `good first issue`. These are typically:

- Adding a new alert channel (email, Discord, Telegram)
- CLI UX improvements (better error messages, colored output)
- Documentation improvements
- Adding test coverage for edge cases

### Larger Contributions

For anything beyond small fixes, open an issue first to discuss the approach. This is especially important for:

- New CLI commands
- Database schema changes
- Changes to the monitor cycle logic
- New RPC client methods

### PR Checklist

Before submitting a PR, verify:

- [ ] Tests pass (`npm test`)
- [ ] Type check passes (`npx tsc --noEmit`)
- [ ] Lint passes (`npm run lint`)
- [ ] Tests cover the new functionality (TDD preferred)
- [ ] No unnecessary dependencies added
- [ ] Commit messages follow conventional format
- [ ] Code matches the project's style and conventions
- [ ] No `console.log` in core logic
- [ ] ADR created if making a significant design decision
- [ ] E2E sandbox tested (for changes affecting RPC or daemon interactions)

## Getting Help

If you're stuck or have questions about the codebase, open an issue or reach out on X ([@The_good_man02](https://twitter.com/The_good_man02)). We'd rather answer questions early than review a PR that went in the wrong direction.
