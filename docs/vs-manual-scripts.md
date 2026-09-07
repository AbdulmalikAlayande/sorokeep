# Comparing Sorokeep vs. Manual TTL Management Scripts

Soroban smart contracts operate on a state archival storage model. Every on-chain entry — contract instance, WASM code, and persistent storage — has a Time-To-Live (TTL). When an entry's TTL drops to zero, Stellar archives the entry, rendering the contract or its state inaccessible until paid to restore.

To prevent archival, engineering teams often face a choice: **write a custom shell script or cron job using `soroban-cli`, or deploy a dedicated lifecycle management tool like Sorokeep.**

This document provides a clear-eyed technical comparison between manual scripts and Sorokeep to help teams evaluate tradeoffs, understand operational risks, and choose the right approach for their infrastructure.

---

## What a Manual TTL Script Looks Like

A typical hand-rolled solution consists of a cron job running a bash or Python script that invokes `soroban-cli` on a schedule:

```bash
#!/usr/bin/env bash
# Typical manual TTL extension script executed via cron (e.g., every 6 hours)

CONTRACT_ID="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

# Extend instance TTL
soroban contract extend \
  --source-account S... \
  --rpc-url https://soroban-rpc.mainnet.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --contract-id "$CONTRACT_ID" \
  --durability instance \
  --ledgers-to-extend 100000 \
  --durability-to-extend 200000
```

While this script works for simple use cases, production smart contract deployments quickly uncover edge cases that manual scripts struggle to handle cleanly.

---

## High-Level Feature Matrix

| Capability | Hand-Rolled Script (`soroban-cli` + Cron) | Sorokeep (`sorokeep`) |
| :--- | :--- | :--- |
| **TTL Health Checks** | Manual CLI queries per entry | Continuous polling daemon (`sorokeep status`, `sorokeep daemon`) |
| **Footprint Discovery** | Manual list of explicit keys | On-chain footprint introspection & WASM analysis (`sorokeep watch`, `sorokeep inspect`) |
| **Auto-Extension** | Static script executions | Policy-based triggers & pre-submission simulation (`sorokeep guard`) |
| **Alerting** | Cron failure emails / custom webhooks | Multi-channel notifications: Webhook, Slack, Discord, Telegram, PagerDuty, Opsgenie, Teams, Matrix (`sorokeep alerts`) |
| **Archival Restoration** | Fails silently or errors on archived state | Automated simulation & recovery via `RestoreFootprintOp` (`sorokeep restore`) |
| **Cost & Rent Tracking** | None (untracked transaction fees) | Historical XLM cost logs & 30-day rent spend projections (`sorokeep costs`) |
| **Budget Caps** | None (risk of runaway spend) | Hard monthly spending limits & `budget_exhausted` alerts (`sorokeep budget`) |
| **Resource Usage Trends** | None | CPU & memory usage trend monitoring (`sorokeep resources`) |
| **Transaction Parallelism** | Sequence number collisions on shared secret key | Managed channel account pools for non-blocking concurrent submissions (`sorokeep channels`) |
| **CI/CD Quality Gates** | Custom script return code handling | Native exit-code-based threshold checks (`sorokeep check --fail-under <ledgers>`) |
| **Audit Logging** | Unstructured log files | SQLite database event queue & auditable action logs (`sorokeep audit-log`) |

---

## Detailed Comparison: Where Manual Scripts Fall Short

### 1. Silent Failures & Lack of Multi-Channel Alerting
- **Manual Scripts**: Cron failures (RPC timeouts, out-of-gas errors, bad secret keys) write to local stdout/stderr or log files. If unmonitored, the script fails silently while the contract TTL silently decays toward zero.
- **Sorokeep**: Uses a decoupled, queue-backed alerting subsystem (`sorokeep alerts`). Supports Webhooks (HMAC-SHA256 signed), Slack Block Kit, Discord Embeds, Telegram, PagerDuty, Opsgenie, Microsoft Teams, and Matrix. Alerts fire on threshold breaches, resource spikes, state changes, and budget limits.

### 2. Footprint Discovery & Blind Spots
- **Manual Scripts**: A contract does not only consist of its contract ID. It also relies on its WASM code entry and potentially dozens of persistent data entries. Manual scripts often extend only the contract instance, forgetting WASM code or storage keys. If the WASM code expires, the entire contract freezes.
- **Sorokeep**: Running `sorokeep watch <contract-id>` automatically discovers contract instances, WASM code entries, and associated storage footprints on-chain using RPC introspection.

### 3. Archival Recovery Failure (`RestoreFootprintOp`)
- **Manual Scripts**: If a contract or storage entry drops below the minimum TTL and becomes archived, calling `soroban contract extend` returns an RPC error (`InvalidFootprint`). A basic script cannot recover from this state without custom logic to construct and submit a `RestoreFootprintOp`.
- **Sorokeep**: Includes dedicated restoration support (`sorokeep restore <contract-id>`). It simulates the restoration transaction, determines required footprints, submits `RestoreFootprintOp`, and updates internal tracking.

### 4. Sequence Number Collisions & Concurrency Bottlenecks
- **Manual Scripts**: When extending multiple contracts or entries simultaneously using a single source account key, parallel cron runs or loop iterations encounter sequence number mismatch errors.
- **Sorokeep**: Manages a pool of channel accounts (`sorokeep channels`). Channel accounts act as fee-bumping, sequence-holding signers, enabling safe parallel transaction submissions without sequence bottlenecks.

### 5. Runaway Rent Costs & Lack of Financial Controls
- **Manual Scripts**: Automatic extension scripts write transactions to mainnet unconditionally. If network fee spikes occur or contracts generate thousands of dynamic storage keys, script execution costs can escalate unexpectedly.
- **Sorokeep**: Provides cost visibility (`sorokeep costs`) with 30-day spend projections and enables strict budget enforcement (`sorokeep budget`). When a monthly XLM cap is reached, Sorokeep blocks automated extensions and triggers a `budget_exhausted` alert to team channels.

### 6. CI/CD Integration
- **Manual Scripts**: Verifying contract health in staging or deployment pipelines requires custom parsing of raw JSON RPC responses.
- **Sorokeep**: Includes a dedicated CI command (`sorokeep check <contract-id> --fail-under <ledgers>`). It inspects contract TTL health and exits with code `1` if any entry falls below the threshold, allowing deployment pipelines to block risky deployments automatically.

---

## When a Manual Script Is Still the Right Choice

Sorokeep is designed for production deployments and team environments, but a manual script or simple cron job may still be the preferred choice in certain scenarios:

1. **Single-Contract Pet Projects & Prototypes**: If you are deploying a single contract on testnet or a local standalone network for testing, setting up a daemon or database queue may be unnecessary overhead.
2. **Self-Extending Smart Contracts**: Contracts that incorporate state extension logic directly into user-facing function invocations (where users pay gas for TTL extension during routine interaction) may not require external automated extension scripts.
3. **Strict Zero-Dependency Environments**: Environments where running Node.js 22+ runtime or maintaining a persistent SQLite database is constrained by infrastructure policies.

---

## Migration Path: Moving from Manual Scripts to Sorokeep

Transitioning from a manual cron job to Sorokeep involves three simple steps:

1. **Register Contracts**:
   ```bash
   sorokeep watch <contract-id> --network mainnet --name "Core Protocol"
   ```
2. **Configure Guard Policies & Alerts**:
   ```bash
   # Set auto-extension policy
   sorokeep guard <contract-id> --threshold 20000 --target-ttl 100000 --auto-extend --keypair-env STELLAR_SECRET_KEY

   # Add notification channel
   sorokeep alerts add --contract <contract-id> --type slack --channel C12345678 --threshold 25000
   ```
3. **Deploy the Daemon**:
   Run `sorokeep daemon` as a systemd service or Docker container to handle continuous background polling and auto-extension.
