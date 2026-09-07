# Migrating from Raw Soroban CLI Scripts to Sorokeep

This guide helps teams transition from ad-hoc `soroban-cli` / `stellar contract extend-ttl` cron jobs and custom shell scripts to Sorokeep.

---

## Why Migrate?

Many teams start by setting up simple shell scripts and cron jobs calling `stellar contract extend-ttl` or `soroban contract extend`. While this works initially, custom scripts create operational overhead:

- **Blind extensions waste XLM:** Cron jobs typically extend TTL on a fixed schedule regardless of whether an extension is actually needed.
- **No failure visibility:** When a cron job fails (due to sequence errors, out-of-gas, or RPC downtime), there are no built-in alerts.
- **Missing state tracking:** Raw CLI calls do not maintain history, audit trails, or 30/60/90-day cost forecasting.
- **Single-entry blind spots:** Scripts often only extend the contract instance while forgetting the underlying WASM code or persistent storage entries.

Sorokeep replaces these brittle scripts with an automated, policy-driven daemon featuring pre-submission simulations, multi-channel alerting, and cost tracking.

---

## Command Mapping Reference

Use this cheat sheet to map common `soroban-cli` and `stellar-cli` script patterns to their Sorokeep equivalents.

| Action / Old Pattern | `soroban-cli` / `stellar-cli` / Script | Sorokeep Equivalent |
|---|---|---|
| **Register & Discover** | Manual list of contract IDs in bash arrays | `sorokeep watch <CONTRACT_ID> --network <net> --name <name>`<br/>*(Auto-discovers instance & WASM entries)* |
| **Bulk Register** | Looping over a text file in bash | `sorokeep watch --from-file contracts.yaml` |
| **Check TTL / Health** | Custom `curl` to `getLedgerEntries` RPC + jq | `sorokeep status <CONTRACT_ID>` |
| **CI / CD Health Check** | Bash script checking if TTL < threshold | `sorokeep check <CONTRACT_ID> --fail-under 20000` |
| **One-Off Simulation** | `stellar contract extend-ttl --durability ... --sim-only` | `sorokeep guard <CONTRACT_ID> --dry-run` |
| **Automated Extension** | Crontab executing `stellar contract extend-ttl` periodically | `sorokeep guard <CONTRACT_ID> --auto-extend --threshold 20000 --target-ttl 100000 --keypair-env KEYPAIR_SECRET` |
| **Bulk Policy Setup** | Running extension scripts across contract lists | `sorokeep tag add <CONTRACT_ID> <TAG>`<br/>`sorokeep guard --tag <TAG> --auto-extend ...` |
| **Restore Archived Entry** | `stellar contract restore --id <CONTRACT_ID>` | `sorokeep restore <CONTRACT_ID> --keypair-env KEYPAIR_SECRET` |
| **Alert on Low TTL** | Custom monitoring / scraping scripts | `sorokeep alerts add --contract <CONTRACT_ID> --type <webhook\|slack\|telegram\|discord\|pagerduty> --threshold 10000` |
| **Cost Estimation** | Manual spreadsheet calculations | `sorokeep guard cost-estimate <CONTRACT_ID> --target-ttl 50000,100000,200000` |
| **Historical Auditing** | Grepping cron logs | `sorokeep history <CONTRACT_ID>` or `sorokeep audit-log` |

---

## Step-by-Step Migration Guide

### Step 1: Inventory Existing Contracts & Parameters

Gather your current script parameters:
1. **Contract IDs** currently being bumped.
2. **Network** (`testnet`, `mainnet`, or custom RPC).
3. **Thresholds & Target TTL:** Note how many ledgers you currently extend by.
4. **Signer Key:** Identify the secret key or environment variable used to sign extension transactions.

### Step 2: Register Contracts in Sorokeep

Register each contract. Sorokeep automatically performs contract introspection to track both the instance entry and the WASM bytecode:

```bash
sorokeep watch CA3D5KRYMCM... --network mainnet --name "Vault Contract"
```

If you manage a fleet of contracts, you can register them from a single YAML file:

```yaml
# contracts.yaml
contracts:
  - id: CA3D5KRYMCM...
    name: "Vault Contract"
    network: mainnet
    tags: ["core", "defi"]
  - id: CB76XROA...
    name: "Token Pool"
    network: mainnet
    tags: ["defi"]
```

```bash
sorokeep watch --from-file contracts.yaml
```

### Step 3: Configure Auto-Extension Policies

Replace your scheduled cron bumping with a declarative guard policy:

```bash
sorokeep guard CA3D5KRYMCM... \
  --auto-extend \
  --threshold 20000 \
  --target-ttl 100000 \
  --keypair-env STELLAR_SECRET_KEY
```

- `--threshold 20000`: Only trigger an extension transaction when the remaining TTL drops below 20,000 ledgers (~27 hours).
- `--target-ttl 100000`: Extend the TTL up to 100,000 ledgers (~5.7 days).
- `--keypair-env STELLAR_SECRET_KEY`: Safely load signing credentials from an environment variable (HashiCorp Vault paths `--keypair-vault` are also supported).

> **Test with Dry-Run:** Run `sorokeep guard CA3D5KRYMCM... --dry-run` to simulate transaction execution and verify fee estimates without broadcasting to the network.

### Step 4: Add Alert Channels

Set up backup alerts so your team is notified if TTL drops unexpectedly:

```bash
sorokeep alerts add \
  --contract CA3D5KRYMCM... \
  --type slack \
  --channel "https://hooks.slack.com/services/..." \
  --threshold 10000
```

### Step 5: Start the Sorokeep Daemon

Run the daemon to monitor contracts and execute extensions based on your configured policies:

```bash
sorokeep daemon --network mainnet
```

For production environments, run the daemon as a systemd service, Docker container, or cloud worker ([Docker guide](deploy-render.md), [Systemd guide](systemd.md)).

---

## Safe Cutover & Retirement Checklist

To avoid a TTL gap during migration, follow this checklist before removing legacy cron jobs:

- [ ] **1. Contracts Registered:** Run `sorokeep status <CONTRACT_ID>` and verify that all contract entries (instance, WASM, persistent) are listed with accurate TTL values.
- [ ] **2. Policy Configured:** Run `sorokeep guard <CONTRACT_ID> --dry-run` to confirm the extension simulation succeeds and keypair resolution works properly.
- [ ] **3. Daemon Running:** Verify that `sorokeep daemon` is active in your deployment environment and completing check cycles without errors.
- [ ] **4. Verify First Automated Extension:** Inspect `sorokeep history <CONTRACT_ID>` or daemon logs to observe at least one successful extension executed by Sorokeep.
- [ ] **5. Disable Legacy Cron:** Once Sorokeep is verified, comment out or remove the legacy cron jobs / shell scripts.
- [ ] **6. Set Up Failure Alerts:** Confirm that alert channels (Slack, Webhook, Telegram, etc.) are tested using `sorokeep alerts test --id <ALERT_ID>`.
