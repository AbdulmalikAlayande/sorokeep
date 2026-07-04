<p align="center">
  <h1 align="center">Sorokeep</h1>
  <p align="center">
    The missing operations layer for deployed Soroban smart contracts.
    <br />
    Monitor TTLs. Get alerted before expiration. Auto-extend storage. Restore archived entries.
    <br />
    <br />
    <a href="#install">Install</a>
    &middot;
    <a href="#quick-start">Quick Start</a>
    &middot;
    <a href="#commands">Commands</a>
    &middot;
    <a href="#alerting">Alerting</a>
    &middot;
    <a href="#contributing">Contributing</a>
  </p>
</p>

<br />

## Why This Exists

Soroban's storage model is uncommon among major smart contract platforms: **state expires.** Every ledger entry — contract instances, persistent storage, WASM code — has a Time-To-Live (TTL). When it runs out, the entry is archived. If a contract's instance entry expires, the entire contract stops working. If persistent storage entries expire, user data becomes inaccessible until someone pays to restore it.

This is by design — state archival keeps Stellar lean and scalable. But it means **you must actively manage the lifecycle of your contract's state, or it dies.**

There is currently no dedicated open-source tool that combines TTL monitoring, alerting, auto-extension, cost tracking, and restoration for Soroban contracts. Developers either use manual CLI commands, build ad-hoc scripts, or embed TTL extension logic directly in their contracts.

Sorokeep is the unified operations layer that handles all of this.

> Security auditors have started flagging TTL mismanagement as a risk area in Soroban contracts. [Veridise](https://veridise.com/audits/soroban/) includes TTL handling in their audit scope. The [LayerZero Stellar endpoint audit](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint) explicitly lists TTL expiration edge cases as a concern. [OpenZeppelin's Stellar contracts library](https://docs.openzeppelin.com/stellar-contracts) deliberately leaves instance storage TTL management to the application developer.

## Features

- **Watch** — Register contracts and automatically discover their instance, WASM, and storage entries
- **Monitor** — Continuous TTL polling with configurable intervals via a long-running daemon
- **Alert** — Extensive notifications (Webhook, Slack, Discord, Telegram, PagerDuty) for low TTLs, resource usage spikes, and state changes
- **Auto-Extend** — Policy-based automatic TTL extension via `ExtendFootprintTTLOp` transactions
- **Restore** — Recover archived entries via `RestoreFootprintOp` transactions
- **Cost & Resource Tracking** — Track extension history, XLM costs, 30-day projections, resource usage logs, and set monthly contract budgets
- **Inspect** — Inspect on-chain state, parse SAC token balances, and diff state changes easily
- **Discovery** — Footprint-based storage key discovery from on-chain transaction activity
- **Channels** — Manage funded channel accounts for concurrent transaction submissions
- **Local-First** — All state stored in SQLite. No external services beyond a Stellar RPC endpoint.
- **MCP Server** — Built-in Model Context Protocol server exposing tools for AI agents to interact with Sorokeep's data natively
- **Advanced Security** — Integrates with AWS Secrets Manager & HashiCorp Vault for secure key resolution, plus robust RPC rate limiting.

## Install

**Requirements:** Node.js 22+

```bash
# From source
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# Run directly
npx tsx src/index.ts --help

# Or link globally after building
npm link
sorokeep --help
```

<!--
# npm (coming soon)
npm install -g sorokeep
-->

## Quick Start

```bash
# 1. Register a contract for monitoring
sorokeep watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token"

# 2. Check its current TTL health
sorokeep status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. Set up a webhook alert (fires when TTL drops below 20,000 ledgers)
sorokeep alerts add \
  --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --type webhook \
  --url https://your-server.com/webhook \
  --threshold 20000

# 4. Start the monitoring daemon
sorokeep daemon --network testnet
```

The daemon will check TTLs every 5 minutes, fire alerts when thresholds are crossed, send resolution notifications when TTLs recover, and auto-extend entries if guard policies are configured.

## Commands

### `sorokeep watch <contract-id>`

Register a contract for monitoring. Connects to the Stellar RPC, discovers the contract's instance and WASM code entries, reads their TTLs, and stores everything locally.

```bash
sorokeep watch <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name <name>` | Human-readable contract name | — |
| `--network <network>` | `testnet` or `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | Custom Stellar RPC endpoint | Network default |
| `--storage-keys <keys>` | Comma-separated base64 XDR storage keys to track | — |

**Example output:**

```
$ sorokeep watch CDLZFC3S...CYSC --network testnet --name "XLM Native Token"

✔ Contract XLM Native Token registered successfully.

  Contract: XLM Native Token (CDLZFC3S...CYSC)
  Network:  testnet
  Entries:  1 discovered
  Instance TTL: 113,918 ledgers (~7d 6h)  OK

  Run 'sorokeep status CDLZFC3S...CYSC' to check TTLs anytime.
  Run 'sorokeep guard CDLZFC3S...CYSC' to enable auto-extension.
```

Entry discovery happens in layers:

1. **Deterministic** (automatic) — Contract instance and WASM code entries, derived from the contract ID and WASM hash. Always tracked.
2. **Footprint-based** (daemon) — Discovered by scanning on-chain transaction events for storage keys your contract uses.
3. **Manual** (opt-in) — Specific storage keys declared via `--storage-keys`.

---

### `sorokeep status <contract-id>`

Display current TTL health for a watched contract. Reads from the local database — no RPC call.

```bash
sorokeep status <contract-id>
```

Shows contract name, network, last checked ledger, and a table of all tracked entries with remaining TTL in ledgers and human-readable time, plus a status indicator (OK / Warning / Critical).

---

### `sorokeep daemon`

Start the long-running monitoring process.

```bash
sorokeep daemon [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--network <network>` | Network to monitor | `testnet` |
| `--interval <ms>` | Polling interval in milliseconds (min: 10,000) | `300000` (5 min) |
| `-r, --rpc-url <url>` | Custom RPC endpoint | Network default |

Each cycle performs three phases:

1. **Monitor** — Fetches fresh TTLs for all contracts, detects threshold crossings, resolves recovered alerts
2. **Deliver** — Dispatches pending alerts to configured webhook and Slack channels
3. **Auto-Extend** — Extends TTLs for contracts with active guard policies

The daemon handles graceful shutdown on `SIGINT`/`SIGTERM` and includes a re-entrance guard to prevent overlapping cycles.

---

### `sorokeep alerts`

Manage alert configurations. Supports five subcommands.

#### `alerts add` — Create a new alert

```bash
sorokeep alerts add [options]
```

| Option | Description |
|--------|-------------|
| `--contract <id>` | Contract ID to alert on (required) |
| `--type <type>` | `webhook` or `slack` (required) |
| `--url <url>` | Webhook POST URL (required for webhook) |
| `--channel <channel>` | Slack channel name or ID (required for slack) |
| `--threshold <ledgers>` | Fire when remaining TTL drops below this (required) |
| `--secret <secret>` | HMAC signing secret for webhooks (auto-generated if omitted) |

For webhook alerts, an HMAC signing secret is auto-generated (32-byte hex) if you don't provide one. The secret is displayed once at creation time — save it to verify webhook signatures on your server. See [Webhook Signing](#webhook-signing) for details.

#### `alerts list` — View configured alerts

```bash
sorokeep alerts list --contract <id>
```

#### `alerts remove` — Delete an alert configuration

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test` — Send a test alert

```bash
sorokeep alerts test --id <config-id>
```

Fires a synthetic `threshold_crossed` event through the real delivery pipeline. Useful for verifying that your webhook endpoint or Slack channel is correctly configured before going live.

#### `alerts history` — View past alert activity

```bash
sorokeep alerts history --contract <id> [--limit 20]
```

Shows a table of fired alerts: timestamp, entry label, TTL at fire, channel type, delivery status, retry count, and resolution time.

---

### `sorokeep guard`

Configure auto-extension policies. When enabled, the daemon automatically extends TTLs by submitting `ExtendFootprintTTLOp` transactions using a funded Stellar keypair.

```bash
sorokeep guard <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--target-ttl <ledgers>` | TTL to extend entries to | `100000` |
| `--threshold <ledgers>` | Extend when TTL drops below this | `20000` |
| `--keypair <secret>` | Stellar secret key (for one-time extension) | — |
| `--keypair-env <var>` | Env var name containing the secret key | — |
| `--auto-extend` | Enable daemon auto-extension (requires `--keypair-env`) | — |
| `--dry-run` | Simulate extension and show estimated fee | — |
| `--disable` | Disable auto-extension for this contract | — |

**Usage modes:**

```bash
# Check current policy
sorokeep guard <contract-id>

# Dry run — see estimated fee without submitting
sorokeep guard <contract-id> --keypair S... --dry-run

# One-time immediate extension
sorokeep guard <contract-id> --keypair S...

# Enable auto-extension for the daemon
sorokeep guard <contract-id> --keypair-env STELLAR_SECRET_KEY --auto-extend

# Disable auto-extension
sorokeep guard <contract-id> --disable
```

**Security:** Secret keys are never stored in the database. When using `--auto-extend`, only the public key and the environment variable name are persisted. The daemon resolves the actual secret key from the environment at runtime.

---

### `sorokeep costs`

View extension history and rent spending for a contract.

```bash
sorokeep costs <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--period <days>` | Show costs for the last N days | `30` |
| `--all` | Show all history | — |

**Output includes:**

- Total extensions and total cost in XLM
- Breakdown by entry type (instance, wasm, persistent) with count and cost
- 30-day cost projection extrapolated from the selected period
- Recent extensions table: timestamp, entry label, old TTL → new TTL, cost in XLM, transaction hash

---

### `sorokeep restore`

Recover archived ledger entries via `RestoreFootprintOp` transactions.

```bash
sorokeep restore <contract-id> [options]
```

| Option | Description |
|--------|-------------|
| `--keypair <secret>` | Stellar secret key |
| `--keypair-env <var>` | Env var containing secret key |
| `--entry <keyXdr>` | Specific entry key XDR to restore (repeatable) |
| `--all` | Restore all tracked entries for the contract |

One of `--keypair` or `--keypair-env` is required. One of `--entry` or `--all` is required (mutually exclusive).

```bash
# Restore a specific entry
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --entry <base64-xdr>

# Restore all tracked entries
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all
```

---

### `sorokeep resources`

View resource usage logs (CPU instructions, memory bytes, fee structures) for a contract to track execution efficiency over time.

---

### `sorokeep budget`

Set and monitor a monthly XLM extension budget for a contract. Prevents runaway costs if a contract requires frequent extensions.

---

### `sorokeep channels`

Manage funded channel accounts used to submit extension and restoration transactions concurrently, avoiding sequence number bottlenecks.

---

### `sorokeep inspect`

Inspect on-chain state directly. Can parse Stellar Asset Contract (SAC) token balances, diff state changes, and decode XDR without manual intervention.

---

### `sorokeep check`

Perform an ad-hoc, one-off execution of the monitoring cycle without starting the long-running daemon.

---

### `sorokeep db`

Database management tasks, including migrations, backups, and introspection cache management.

---

### `sorokeep completion`

Generate shell autocomplete scripts for bash/zsh to enable tab completion for all Sorokeep commands.

## Alerting

Sorokeep delivers alerts through two channels: **webhooks** and **Slack**. Each alert includes a severity level and rich context about the affected entry.

### Alert Lifecycle

1. **Threshold Crossed** — During each monitoring cycle, if an entry's remaining TTL drops below a configured threshold, Sorokeep fires a `threshold_crossed` alert.
2. **Delivery** — The dispatcher routes the alert to the configured channel (webhook or Slack). Failed deliveries are retried on subsequent cycles, up to 5 attempts.
3. **Resolution** — When TTL recovers past the threshold (e.g., after an extension), Sorokeep fires an `alert_resolved` notification to all configured channels.

### Severity Levels

Severity is computed automatically based on how much TTL remains relative to the configured threshold:

| Severity | Condition | Description |
|----------|-----------|-------------|
| **critical** | Remaining TTL < 25% of threshold, or TTL = 0 | Entry is in immediate danger of archival |
| **warning** | Remaining TTL is below threshold but above 25% | Entry needs attention soon |
| **info** | Alert resolved (TTL recovered) | Entry is healthy again |

### Webhook Delivery

Webhook alerts are delivered as HTTP POST requests with a JSON body:

```json
{
  "type": "threshold_crossed",
  "severity": "warning",
  "contractId": "CDLZFC3S...",
  "contractName": "XLM Native Token",
  "network": "testnet",
  "entry": {
    "keyXdr": "AAAA1234...",
    "type": "instance",
    "label": "Contract Instance"
  },
  "threshold": {
    "configuredLedgers": 20000,
    "currentRemainingLedgers": 8500,
    "approximateTimeRemaining": "~13h 0m"
  },
  "firedAtLedger": 2500000,
  "timestamp": "2026-06-13T12:00:00.000Z"
}
```

### Webhook Signing

Webhook requests include an HMAC-SHA256 signature in the `X-Sorokeep-Signature` header for payload verification:

```
X-Sorokeep-Signature: sha256=a1b2c3d4e5f6...
```

To verify on your server:

```javascript
import { createHmac } from "node:crypto";

function verifySignature(payload, signature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return signature === expected;
}
```

The signing secret is auto-generated when you create a webhook alert (or you can provide your own with `--secret`). It is displayed once at creation time — store it securely.

### Slack Delivery

Slack alerts are sent via the [Slack Web API](https://api.slack.com/methods/chat.postMessage) using Block Kit for rich formatting. Messages include severity icons, contract details, remaining TTL, and actionable hints.

**Setup:**

1. Create a Slack app with `chat:write` scope at [api.slack.com/apps](https://api.slack.com/apps)
2. Install the app to your workspace and copy the Bot User OAuth Token (`xoxb-...`)
3. Provide the token via environment variable:

```bash
export SOROKEEP_SLACK_TOKEN=xoxb-your-bot-token
```

Alternatively, store the token in your config file at `~/.sorokeep/config.yaml`:

```yaml
slackToken: "xoxb-your-bot-token"
```

The environment variable takes precedence over the config file.

### Retry Policy

Failed alert deliveries are automatically retried on subsequent daemon cycles. After **5 consecutive failures**, the alert is abandoned and no further delivery attempts are made. You can view delivery status and retry counts with `sorokeep alerts history`.

## How It Works

Sorokeep is an off-chain monitoring tool. It reads data from the Stellar RPC, stores it locally in SQLite, and acts on it (alerts, auto-extension, restoration). It does not run on-chain and does not require you to modify your contracts.

```
                         ┌─────────────────────┐
                         │   Stellar Network    │
                         │  (testnet / mainnet) │
                         └──────────┬───────────┘
                                    │ RPC
                         ┌──────────▼───────────┐
                         │   Sorokeep    │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │  Monitor Cycle   │  │
                         │  │  (fetch TTLs,    │  │
                         │  │   detect alerts, │  │
                         │  │   resolve)       │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │   Dispatcher     │  │
                         │  │  (webhook/slack) │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │  Auto-Extend     │  │
                         │  │  (guard policy)  │  │
                         │  └─────────────────┘  │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │   SQLite DB      │  │
                         │  │  ~/.soroban-     │  │
                         │  │   sorokeep/     │  │
                         │  │   sorokeep.db    │  │
                         │  └─────────────────┘  │
                         └───────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐  ┌────────────┐  ┌────────────┐
              │ Webhooks │  │   Slack    │  │  Terminal  │
              └──────────┘  └────────────┘  └────────────┘
```

### The Daemon Cycle

Every polling interval (default: 5 minutes), the daemon runs three phases:

1. **Monitor** — For each registered contract, fetches fresh TTLs from the RPC, updates the database, checks each entry against every configured alert threshold. Fires `threshold_crossed` when TTL drops below a threshold; fires `alert_resolved` when TTL recovers.

2. **Deliver** — Processes all undelivered alerts. Routes each to its configured channel (webhook or Slack), marks successful deliveries, increments retry counters on failures, abandons after 5 retries.

3. **Auto-Extend** — For contracts with an active guard policy, checks which entries have TTL below the policy threshold and submits `ExtendFootprintTTLOp` transactions to extend them. Records the extension cost in XLM.

### Storage

All state is local. Sorokeep stores data in `~/.sorokeep/sorokeep.db` (SQLite with WAL mode). No external services required beyond a Stellar RPC endpoint.

**Database tables:**

| Table | Purpose |
|-------|---------|
| `contracts` | Registered contracts with network, name, WASM hash |
| `contract_entries` | Tracked ledger entries with TTLs and discovery source |
| `extension_policies` | Auto-extension rules per contract (threshold, target, keypair reference) |
| `alert_configs` | Alert channels, thresholds, and webhook secrets |
| `alerts_fired` | Fired alert records with delivery status, retry count, and resolution tracking |
| `extension_history` | Every TTL extension with transaction hash and XLM cost |

### Configuration

Sorokeep stores user configuration in `~/.sorokeep/config.yaml`:

```yaml
network: testnet
pollingIntervalSeconds: 300
slackToken: "xoxb-..."        # Optional — can also use SOROKEEP_SLACK_TOKEN env var
rpcUrl: "https://..."         # Optional — overrides network default
```

The config file is created with `0600` permissions (owner read/write only) to protect sensitive values like the Slack token.

## Project Structure

```
sorokeep/
├── src/
│   ├── index.ts                 # CLI entry point (Commander.js)
│   ├── commands/                # CLI command handlers (thin presentation layer)
│   │   ├── watch.ts             # Contract registration
│   │   ├── status.ts            # TTL health display
│   │   ├── daemon.ts            # Long-running monitor
│   │   ├── alerts.ts            # Alert CRUD + test + history
│   │   ├── guard.ts             # Auto-extension policies
│   │   ├── costs.ts             # Extension cost reporting
│   │   └── restore.ts           # Archived entry recovery
│   ├── core/                    # Business logic (no CLI dependencies)
│   │   ├── watch.ts             # Contract registration and discovery
│   │   ├── monitor.ts           # Polling cycle, threshold detection, resolution
│   │   ├── extension.ts         # TTL extend, auto-extend, restore, cost recording
│   │   └── discovery.ts         # Footprint-based storage key discovery
│   ├── alerts/                  # Alert delivery pipeline
│   │   ├── types.ts             # AlertEvent, AlertSeverity, buildAlertEvent
│   │   ├── dispatcher.ts        # Routing, retry logic, delivery orchestration
│   │   ├── webhook.ts           # HTTP POST with HMAC-SHA256 signing
│   │   └── slack.ts             # Slack Web API + Block Kit formatting
│   ├── daemon/                  # Daemon lifecycle
│   │   └── loop.ts              # Start/stop, re-entrance guard, cycle orchestration
│   ├── rpc/                     # Stellar RPC client wrapper
│   │   └── client.ts            # Instance/WASM fetch, batch TTLs, extend, restore
│   ├── db/                      # Database layer
│   │   ├── schema.sql           # Full SQLite schema
│   │   ├── database.ts          # Init, WAL mode, live migrations
│   │   └── repositories.ts      # All query functions
│   ├── logging/                 # Structured logging (pino)
│   └── utils/                   # Config loader, TTL formatting
├── tests/                       # Mirrors src/ structure — 238 tests across 14 files
├── .github/workflows/           # CI (test + type-check) and publish
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── LICENSE
└── CONTRIBUTING.md
```

**Architecture layers:**

- **Commands** (`src/commands/`) — Thin CLI layer. Parses arguments, calls core, formats terminal output. No business logic.
- **Core** (`src/core/`) — Pure business logic. Testable without network or CLI. The daemon reuses the same functions.
- **RPC** (`src/rpc/`) — Stellar SDK wrapper. All network calls go through here. Handles transaction building, simulation, signing, and submission.
- **Alerts** (`src/alerts/`) — Delivery pipeline. Channel-specific formatting and transport, routing, retry management.
- **DB** (`src/db/`) — SQLite repositories. All queries centralized here. In-memory mode for tests.

## Tech Stack

| Package | Purpose |
|---------|---------|
| [TypeScript](https://www.typescriptlang.org/) | Application language (ESM) |
| [@stellar/stellar-sdk](https://github.com/nicktomlin/js-stellar-sdk) | Stellar and Soroban RPC interactions |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Local database (synchronous, zero external deps) |
| [Commander.js](https://github.com/tj/commander.js) | CLI framework |
| [pino](https://github.com/pinojs/pino) | Structured JSON logging |
| [chalk](https://github.com/chalk/chalk) / [ora](https://github.com/sindresorhus/ora) | Terminal formatting and spinners |
| [yaml](https://github.com/eemeli/yaml) | Config file parsing |
| [Vitest](https://vitest.dev/) | Test framework |

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/core/monitor.test.ts

# Watch mode
npx vitest
```

**238 tests** across **14 test files** covering:

- **Formatting** — TTL conversion, status classification, human-readable time
- **Database** — CRUD, cascades, upserts, deduplication, alert delivery queries
- **RPC Client** — Contract instance, WASM code, batch TTL queries
- **Watch** — Registration, re-watch, SAC contracts, error handling, network isolation
- **Monitor Cycle** — TTL refresh, threshold detection, alert deduplication, resolution, fault isolation, multi-threshold escalation, partial RPC responses
- **Extension** — TTL extension, auto-extension policy evaluation, restore, cost recording
- **Alert Dispatcher** — Channel routing, retry logic, max retry cap, abandoned alerts
- **Webhook** — HMAC signing, timeout handling, HTTP error responses
- **Slack** — Token resolution, Block Kit structure, `body.ok` validation
- **CLI Commands** — Alerts add/list/remove/test/history, email type blocking
- **Config** — Load/save, defaults, parse failure handling, file permissions
- **Daemon** — Start/stop, re-entrance guard, cycle error isolation

All tests use in-memory SQLite databases and mocked RPC responses — no network calls, no filesystem side effects.

## FAQ

### Why TypeScript, not Rust?

Sorokeep is an off-chain operational tool, not a smart contract. TypeScript was chosen because:

1. The Stellar JS SDK is the most complete client library for Soroban RPC interactions
2. Soroban developers already have Node.js in their toolchain
3. npm distribution means zero-friction installation
4. The performance requirements (periodic RPC polling) are well within Node.js capabilities
5. It maximizes the contributor pool — most Soroban developers know TypeScript

### Is my secret key stored anywhere?

No. When you configure auto-extension with `--keypair-env`, Sorokeep stores only the **public key** and the **environment variable name** in the database. The actual secret key is resolved from your environment at runtime. If you use `--keypair` for a one-time operation, the key is used in-memory and never persisted.

### What happens if the daemon crashes mid-cycle?

Each phase (monitor, deliver, auto-extend) is wrapped in isolated error handling. A failure in one phase doesn't prevent the others from running. Alert deliveries are idempotent — if a delivery was marked successful, it won't be re-sent. If the daemon restarts, undelivered alerts will be picked up on the next cycle.

### What networks are supported?

Testnet (`https://soroban-testnet.stellar.org`) and Mainnet (`https://mainnet.sorobanrpc.com`). You can also point Sorokeep at any custom RPC endpoint with `--rpc-url`.

### What about email alerts?

Email is not yet implemented. The CLI will reject `--type email` with a clear error message. Webhook and Slack are the supported channels today.

## Roadmap

- Web dashboard for visual TTL monitoring
- npm library mode for CI/CD integration
- MCP server for AI-assisted development tools
- Email alert channel
- Multi-contract batch operations

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## Author

**Abdulmalik Alayande**

- GitHub: [@AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
