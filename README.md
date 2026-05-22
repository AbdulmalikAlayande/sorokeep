# Soroban Sentinel

The missing operations layer for deployed Soroban smart contracts.

Soroban Sentinel monitors the health of your deployed contracts — tracking state TTLs, alerting before expiration, and auto-extending storage lifetimes so your contracts don't die in their sleep.

## Why this exists

Soroban's storage model is uncommon among major smart contract platforms: **state expires.** Every ledger entry, contract instances, persistent storage, WASM code etc., all have a Time-To-Live (TTL). When it runs out, the entry is archived. If a contract's instance entry expires, the entire contract stops working. If persistent storage entries expire, user data becomes inaccessible until someone pays to restore it.

This is by design, state archival keeps Stellar lean and scalable. But it means **you must actively manage the lifecycle of your contract's state, or it dies.**

There is currently no dedicated open-source tool that combines TTL monitoring, alerting, auto-extension, cost tracking, and restoration for Soroban contracts. Developers either use manual CLI commands, build ad-hoc scripts, or embed TTL extension logic directly in their contracts. Sentinel is the unified operations layer that handles all of this.

Security auditors have started flagging TTL mismanagement as a risk area in Soroban contracts. [Veridise](https://veridise.com/audits/soroban/) includes TTL handling in their audit scope. The [LayerZero Stellar endpoint audit](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint) explicitly lists TTL expiration edge cases as a concern. [OpenZeppelin's Stellar contracts library](https://docs.openzeppelin.com/stellar-contracts) deliberately leaves instance storage TTL management to the application developer.

## What's working right now

Sentinel is under active development. Here's what works today:

**`sentinel watch <contractId>`** — Register a contract for monitoring. Connects to Stellar testnet or mainnet, discovers the contract's instance entry and WASM code entry, reads their TTLs, and stores everything locally in SQLite.

```
$ sentinel watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --network testnet --name "XLM Native Token"

✔ Contract XLM Native Token registered successfully.

  Contract: XLM Native Token (CDLZFC3S...CYSC)
  Network:  testnet
  Entries:  1 discovered
  Instance TTL: 113,918 ledgers (~7d 6h)  OK

  Run 'sentinel status CDLZFC3S...CYSC' to check TTLs anytime.
  Run 'sentinel guard CDLZFC3S...CYSC' to enable auto-extension.
```

**`sentinel status <contractId>`** — Display current TTL health, live until ledger, and remaining TTL for a watched contract in a clean, human-readable terminal format.

**`sentinel daemon`** — Run the long-running daemon process. Every polling cycle (default 5 minutes), it re-checks contract entries, updates database states, records alert threshold crossings, resolves alerts when TTLs recover, and dispatches pending alerts to external notification channels.

**`sentinel alerts`** — Manage notification configurations. Supports subcommands to `add`, `list`, and `remove` alert channels (webhooks, Slack channel targets) per contract with custom ledger thresholds.

**Alert Delivery Dispatcher** — Background delivery engine for fired alerts:
- **Webhook**: Posts a detailed JSON payload containing the event context, complete with connection timeouts and HTTP status check.
- **Slack**: Sends rich messages using Slack Block Kit, with built-in token validation.

**Database layer** — SQLite schema for contracts, entries, extension policies, alert configs, fired alerts, and extension history. All with foreign key cascades, upsert support, and an in-memory mode for testing.

## What's coming next

These are concrete next steps, not a wish list:

- **`sentinel guard`** — Auto-extend TTLs by submitting `ExtendFootprintTTLOp` transactions
- **`sentinel costs`** — Track rent spending per contract over time
- **`sentinel restore`** — Restore archived entries via `RestoreFootprintOp`

Longer term: transaction footprint-based storage key discovery, web dashboard, npm library mode for CI/CD integration, and MCP server for AI-assisted development tools.

## Install

Requires Node.js 22+.

```bash
# From source (current method)
git clone https://github.com/AbdulmalikAlayande/soroban-sentinel.git
cd soroban-sentinel
npm install
npx tsx src/index.ts --help

# npm install coming soon
# npm install -g soroban-sentinel
```

## Usage

```bash
# See all commands
sentinel --help

# Watch a contract on testnet
sentinel watch <contractId> --network testnet --name "My Contract"

# Watch a contract on mainnet
sentinel watch <contractId> --network mainnet --name "Production Pool"

# Use a custom RPC endpoint
sentinel watch <contractId> --network testnet --rpc-url https://my-rpc.example.com
```

## How it works

Sentinel is an off-chain monitoring tool. It reads data from the Stellar RPC, stores it locally in SQLite, and acts on it (alerts, auto-extension). It does not run on-chain and does not require you to modify your contracts.

The core workflow:

1. **Register** a contract with `sentinel watch` — Sentinel discovers instance and WASM entries, reads their TTLs, stores everything in `~/.soroban-sentinel/sentinel.db`
2. **Monitor** with the daemon — every 5 minutes, Sentinel re-fetches TTLs for all registered contracts and checks them against your configured thresholds
3. **Alert** when TTLs drop below thresholds — webhook POST, Slack message, or email
4. **Auto-extend** if configured — Sentinel builds and submits `ExtendFootprintTTLOp` transactions using a funded keypair you provide
5. **Track costs** — every extension is recorded with the transaction hash and XLM cost

### Entry discovery

Sentinel discovers contract entries in three layers:

- **Deterministic entries (automatic):** Contract instance and WASM code entries are constructed from the contract ID and WASM hash. These are always tracked.
- **Footprint-based discovery (planned):** By watching transactions that invoke your contract, Sentinel will learn which persistent storage keys exist and start tracking their TTLs too.
- **Developer hints (supported):** You can declare specific storage keys to track via CLI flags or config.

### Storage

All state is local. Sentinel stores data in `~/.soroban-sentinel/sentinel.db` (SQLite). No external services required beyond a Stellar RPC endpoint.

Database tables:

- `contracts` — registered contracts with network, name, WASM hash
- `contract_entries` — tracked ledger entries with TTLs and discovery source
- `extension_policies` — auto-extension rules per contract
- `alert_configs` — alert channels and thresholds
- `alerts_fired` — deduplication and resolution tracking
- `extension_history` — every TTL extension with tx hash and cost

## Project structure

```
soroban-sentinel/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── commands/             # CLI command handlers (thin presentation layer)
│   │   └── watch.ts
│   ├── core/                 # Business logic (no CLI dependencies)
│   │   ├── watch.ts          # Contract registration and discovery
│   │   └── monitor.ts        # Polling cycle, threshold detection, resolution
│   ├── rpc/                  # Stellar RPC client wrapper
│   │   └── client.ts
│   ├── db/                   # SQLite database and repositories
│   │   ├── database.ts
│   │   ├── repositories.ts
│   │   └── schema.sql
│   ├── alerts/               # Alert dispatcher (webhook, Slack)
│   ├── daemon/               # Daemon loop and lifecycle
│   ├── logging/              # Structured logging (pino)
│   └── utils/                # Formatting, config helpers
├── tests/                    # Mirrors src/ structure
│   ├── core/
│   │   ├── watch.test.ts
│   │   └── monitor.test.ts
│   ├── db/
│   │   └── database.test.ts
│   ├── rpc/
│   │   └── client.test.ts
│   └── utils/
│       └── formatting.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

The architecture separates concerns into three layers:

- **Core** (`src/core/`) — pure business logic, testable without network or CLI. The daemon reuses the same core functions.
- **RPC** (`src/rpc/`) — Stellar SDK wrapper. All network calls go through here.
- **Commands** (`src/commands/`) — thin CLI layer. Parses args, calls core, formats output.

## Tech stack

- **TypeScript / Node.js** — the application runtime
- **@stellar/stellar-sdk** — Stellar and Soroban RPC interactions
- **better-sqlite3** — local database (synchronous, zero external dependencies)
- **Commander.js** — CLI framework
- **pino** — structured logging
- **chalk / ora** — terminal formatting
- **Vitest** — test framework

## Tests

```bash
# Run all tests
npx vitest run

# Run specific test file
npx vitest run tests/core/monitor.test.ts

# Watch mode
npx vitest
```

201 tests covering:

- Formatting utilities (TTL conversion, status classification)
- Database operations (CRUD, cascades, upserts, deduplication, alert delivery, and query joining)
- RPC client (contract instance, WASM code, batch TTL queries)
- Watch command (registration, re-watch, SAC contracts, error handling, network isolation)
- Monitor cycle (TTL refresh, threshold detection, alert deduplication, resolution, fault isolation, multi-threshold escalation, partial RPC responses)
- Alert Delivery system (webhook integration, Slack Block Kit messages, dispatcher routing and retry logic)
- CLI status, daemon, and alerts commands

## Why TypeScript, not Rust?

Sentinel is an off-chain operational tool, not a smart contract. TypeScript was chosen because:

1. The Stellar JS SDK is the most complete client library for Soroban RPC interactions
2. Soroban developers already have Node.js in their toolchain
3. npm distribution means zero-friction installation
4. The performance requirements (periodic RPC polling) are well within Node.js capabilities
5. It maximizes the contributor pool

## License

MIT

## Author

**Abdulmalik Alayande**

- GitHub: [AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
