Tunde’s journey should feel like “install, point at my contract, then forget about it until something’s wrong.” Here’s that flow, step by step, from his point of view, with plain-English “behind the scenes” notes.

***

## 1. Install and first run

**What Tunde does**

1. Installs Sentinel globally:

   ```bash
   npm install -g soroban-sentinel
   ```

2. Checks that it installed correctly:

   ```bash
   soroban-sentinel --help
   ```

**What he sees**

- A help screen with available commands, for example:

  ```text
  Soroban Sentinel - Guardian for your Soroban contracts

  Usage:
    soroban-sentinel [command] [options]

  Commands:
    watch        Register and start watching a contract
    status       Show TTL and storage health for a contract
    guard        Run the auto-extension daemon for a contract
    alerts       Configure alert channels (webhook, email, Slack)
    costs        Show rent costs and forecasts
    restore      Restore archived entries for a contract
    config       Manage global settings

  Run "soroban-sentinel <command> --help" for details.
  ```

**Behind the scenes (plain English)**

- Sentinel’s binary/CLI entry point is installed and wired up.  
- No contracts are registered yet; the local SQLite DB is either created fresh or opened if it exists.  
- A default config file (e.g., `~/.soroban-sentinel/config.yaml`) may be created with sane defaults (network = mainnet, polling interval, etc.).

***

## 2. Register his DeFi contract for watching

**What Tunde does**

He has his contract ID from deployment, e.g. `CDEF...XYZ`. He registers it:

```bash
soroban-sentinel watch CDEF...XYZ --network mainnet --name my-defi-pool
```

Optional flags: maybe `--tags defi,production`.

**What he sees**

- Sentinel prints something like:

  ```text
  > Registering contract CDEF...XYZ on network mainnet
  > Discovering ledger entries...

  Contract: my-defi-pool (CDEF...XYZ)
    Instance TTL:     92,340 ledgers (~5.3 days)   ✓ OK
    WASM TTL:         181,200 ledgers (~10.5 days) ✓ OK
    Storage entries:  12

  Summary:
    Critical (< 6h):  0
    Warning (< 24h):  1  (storage: pool_state)
    OK:               11

  Contract registered and added to watch list.
  ```

**Behind the scenes**

- Sentinel stores the contract in SQLite with:
  - Contract ID, human name, network, tags.  
- It calls Soroban RPC `getLedgerEntries` with the right keys to:
  - Fetch contract instance, WASM code, and storage entries. [developers.stellar](https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension)
- It calculates each entry’s:
  - `liveUntilLedger` and translates it to “ledgers remaining” and an approximate time based on recent ledger cadence. [stellar](https://stellar.org/blog/developers/not-all-data-is-equal-how-soroban-is-solving-state-bloat-with-state-expiration)
- It saves this snapshot (TTLs, entry keys, types) in the DB as the baseline for monitoring.

***

## 3. Configure alerts

**What Tunde does**

He wants a Slack ping when things get bad and a generic webhook to his ops system. He runs:

```bash
soroban-sentinel alerts add \
  --contract CDEF...XYZ \
  --type slack \
  --channel "#oncall" \
  --threshold-ledgers 5000   # ~7h before expiry
```

and:

```bash
soroban-sentinel alerts add \
  --contract CDEF...XYZ \
  --type webhook \
  --url https://ops.mycompany.com/hooks/sentinel \
  --threshold-ledgers 10000  # ~14h
```

He checks:

```bash
soroban-sentinel alerts list --contract CDEF...XYZ
```

**What he sees**

- Confirmation messages for each alert added:

  ```text
  Added Slack alert for CDEF...XYZ
    channel: #oncall
    threshold: 5,000 ledgers (~7.0 hours)

  Added webhook alert for CDEF...XYZ
    url: https://ops.mycompany.com/hooks/sentinel
    threshold: 10,000 ledgers (~14.1 hours)

  Active alerts for my-defi-pool (CDEF...XYZ):
    1) slack   #oncall      threshold: 5,000 ledgers
    2) webhook https://ops... threshold: 10,000 ledgers
  ```

**Behind the scenes**

- Sentinel persists alert configs scoped to:
  - Contract ID, alert type, target (Slack/webhook/email), threshold in ledgers.  
- It doesn’t send anything yet; it just updates its internal alert rules table.  
- Thresholds will be checked by the daemon on every polling cycle.

***

## 4. Configure auto-extension (optional but likely)

**What Tunde does**

He decides Sentinel should extend TTL automatically up to a target. He has a funded Stellar keypair ready (e.g., stored in env vars). He runs:

```bash
soroban-sentinel guard CDEF...XYZ \
  --network mainnet \
  --keypair SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  --target-ttl 120000 \
  --auto-extend
```

**What he sees**

- Sentinel acknowledges and maybe runs a quick dry-run:

  ```text
  > Starting guardian for my-defi-pool (CDEF...XYZ) on mainnet
  > Target TTL: 120,000 ledgers (~6.9 days)
  > Using keypair: GABC... (public key)

  Initial scan:
    Instance TTL:   92,340 ledgers (~5.3 days)   ✓ above target? no (will extend when below threshold)
    Storage TTLs:   all above safety threshold

  Guardian is now running in the background.
  Alerts:
    - Slack: #oncall (threshold: 5,000 ledgers)
    - Webhook: https://ops.mycompany.com/hooks/sentinel (threshold: 10,000 ledgers)
  ```

**Behind the scenes**

- Sentinel securely loads the keypair (from CLI/env), caches the public key, and stores a reference (not the raw secret, ideally) in its config.  
- It associates an “auto-extension policy” with this contract:
  - Target TTL (in ledgers).  
  - Safety margin and conditions (how close to expiration before extending).  
- It either:
  - Starts a long-running daemon process that polls on a schedule, or  
  - Registers this contract in a watch list that an already-running daemon loop reads.

***

## 5. Daemon starts monitoring

**What Tunde does**

Two options:

- Either `guard` itself becomes the daemon and stays running in his terminal, or  
- He starts a global daemon:

  ```bash
  soroban-sentinel daemon start
  ```

And maybe checks status:

```bash
soroban-sentinel status CDEF...XYZ
```

**What he sees (status)**

- A table of current TTLs and health:

  ```text
  Status for my-defi-pool (CDEF...XYZ) - mainnet

  Contract Instance    TTL: 92,120 ledgers (~5.3 days)   ✓ OK
  WASM Code            TTL: 181,000 ledgers (~10.5 days) ✓ OK
  Storage: pool_state  TTL: 11,500 ledgers (~15.7 hours) ⚠ WARNING (below webhook threshold)
  Storage: balances    TTL: 22,000 ledgers (~30.1 hours) ✓ OK

  Last checked: ledger 12,345,678 (~2 minutes ago)
  ```

**Behind the scenes**

- The daemon runs a loop every N seconds:
  - For each registered contract:
    - Calls `getLedgerEntries` for known keys. [developers.stellar](https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension)
    - Updates TTL values in SQLite.  
  - Compares TTLs to configured thresholds:
    - If an entry’s TTL crossed below a threshold that wasn’t previously breached, it triggers alerts.  
  - For auto-extension:
    - If an entry’s TTL is below some “extension threshold” and below target TTL:
      - Builds an `ExtendFootprintTTLOp` transaction. [developers.stellar](https://developers.stellar.org/docs/build/guides/conventions/extending-wasm-ttl)
      - Simulates it; if OK, submits and waits for confirmation. [developers.stellar](https://developers.stellar.org/docs/build/guides/conventions/extending-wasm-ttl)
      - On success, refreshes TTLs.

***

## 6. TTL drops and the first alert fires

A few days pass. Traffic is steady; some storage entries’ TTLs are getting low.

**What Tunde does**

He’s not doing anything; Sentinel is running.

**What happens behind the scenes**

- On a polling cycle, the daemon sees:

  ```text
  Storage: pool_state TTL: 9,800 ledgers (~13.4 hours)
  ```

- This crosses the webhook threshold (10,000 ledgers) and may also be close to the internal auto-extension threshold.
- Sentinel:
  - Records internally that an alert for this entry/threshold has now fired (to avoid spamming).  
  - Sends a POST to the configured webhook with a JSON payload.  
  - Sends a Slack message to `#oncall` via Slack API.  

If auto-extension is enabled and policy says “extend around 8,000 ledgers”, it might also:

- Build an `ExtendFootprintTTLOp`, simulate, submit, and then refresh TTLs. [developers.stellar](https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension)

**What Tunde sees**

In his Slack `#oncall` channel:

```text
[Soroban Sentinel] TTL WARNING for my-defi-pool (CDEF...XYZ)

Entry: storage: pool_state
Current TTL: 9,800 ledgers (~13.4 hours)
Network: mainnet

Configured thresholds:
  - Webhook: 10,000 ledgers
  - Slack: 5,000 ledgers

Auto-extension: ENABLED (target TTL: 120,000 ledgers)

Next steps:
  - View full status: soroban-sentinel status CDEF...XYZ
  - Update thresholds: soroban-sentinel alerts edit --contract CDEF...XYZ ...
```

In his webhook consumer logs (or dashboard), he sees a JSON payload like:

```json
{
  "contractId": "CDEF...XYZ",
  "contractName": "my-defi-pool",
  "network": "mainnet",
  "entry": "storage:pool_state",
  "ttlLedgers": 9800,
  "ttlApproxSeconds": 48000,
  "alertType": "threshold_crossed",
  "thresholdLedgers": 10000,
  "time": "2026-05-09T10:15:00Z"
}
```

If auto-extension runs right after:

- A few minutes later, a follow-up message might say:

  ```text
  [Soroban Sentinel] TTL EXTENDED for my-defi-pool (CDEF...XYZ)

  Entry: storage: pool_state
  Old TTL: 9,800 ledgers (~13.4 hours)
  New TTL: 120,050 ledgers (~6.9 days)
  Tx hash: abcd...1234
  ```

**What Tunde feels**

- “Okay, I didn’t have to remember TTL details. I got an early warning, and the system already extended it for me. I can always inspect with `status` if I’m worried.”

***

That’s the full user journey: install → register contract → configure alerts (and optionally auto-extension) → daemon monitors → threshold is crossed → alert + (optionally) auto-fix.

If you want, next we can do **Question 2** as: take this journey and refine the CLI commands and outputs so they’re maximally clean and ergonomic, then later map that to code.
