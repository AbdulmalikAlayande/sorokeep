# Sorokeep CLI Reference Manual

The `sorokeep` CLI is the primary interface for managing Soroban smart contract lifecycles, including TTL monitoring, alerting, auto-extension, and state restoration.

## Installation

### From Source

```bash
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# Link globally for easier use
npm link
```

### Direct Execution

You can also run commands directly using `npx`:

```bash
npx tsx src/index.ts --help
```

---

## Quick Start

1. **Register a contract:**
   ```bash
   sorokeep watch <contract-id> --network testnet --name "My Contract"
   ```

2. **Check TTL health:**
   ```bash
   sorokeep status <contract-id>
   ```

3. **Set up an alert:**
   ```bash
   sorokeep alerts add --contract <contract-id> --type webhook --url https://example.com/webhook --threshold 20000
   ```

4. **Start monitoring:**
   ```bash
   sorokeep daemon --network testnet
   ```

---

## Global Configuration

Sorokeep can be configured via a YAML file or environment variables.

### Configuration File

Settings are stored in `~/.sorokeep/config.yaml`.

| Key | Type | Description | Default |
|-----|------|-------------|---------|
| `network` | string | The Stellar network to use (`testnet` or `mainnet`) | `testnet` |
| `rpcUrl` | string | Override the default network RPC URL | — |
| `pollingIntervalSeconds` | number | Interval for the daemon in seconds | `300` |
| `slackToken` | string | Slack Bot User OAuth Token (`xoxb-...`) | — |

**Example `~/.sorokeep/config.yaml`:**

```yaml
network: mainnet
rpcUrl: https://soroban-rpc.stellar.org
pollingIntervalSeconds: 600
slackToken: xoxb-your-slack-token
```

### Environment Variables

Environment variables take precedence over the configuration file.

| Variable | Description |
|----------|-------------|
| `SOROKEEP_SLACK_TOKEN` | Slack Bot User OAuth Token |
| `STELLAR_SECRET_KEY` | A Stellar secret key (often used with `sorokeep guard --keypair-env STELLAR_SECRET_KEY`) |

---

## Command Reference

### `sorokeep watch [contract-id]`

Register and start watching a contract. Connects to the Stellar RPC, discovers the contract's instance and WASM code entries, and stores them locally.

```bash
sorokeep watch <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name <name>` | Human-readable name for the contract | — |
| `--network <network>` | `testnet` or `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | Custom Stellar RPC endpoint | Network default |
| `--storage-keys <keys>` | Comma-separated base64 XDR storage keys to watch | — |
| `--no-introspection` | Skip automatic contract introspection (WASM code fetching) | — |
| `--from-file <path>` | Load multiple contract registrations from a YAML or JSON file | — |

---

### `sorokeep status <contract-id>`

Show the current TTL health and tracked entries for a watched contract. Reads from the local database.

```bash
sorokeep status <contract-id>
```

---

### `sorokeep check <contract-id>`

Check TTL health for a watched contract. Designed for CI/CD environments.

```bash
sorokeep check <contract-id> [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Bypass CI TTL failures and exit with code 0 |
| `--fail-under <ledgers>` | **(Required)** Exit with code 1 if any entry TTL is below this many ledgers |

---

### `sorokeep daemon`

Start the long-running monitoring daemon.

```bash
sorokeep daemon [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--network <network>` | Stellar network to monitor (`testnet` or `mainnet`) | `testnet` |
| `--interval <ms>` | Polling interval in milliseconds (min: 10,000) | `300000` |
| `-r, --rpc-url <url>` | Custom Stellar RPC endpoint | Network default |
| `--log-format <format>` | Log output format: `pretty` or `json` | `pretty` |

---

### `sorokeep alerts`

Manage alert configurations.

#### `alerts add`

Create a new alert configuration.

```bash
sorokeep alerts add [options]
```

| Option | Description |
|--------|-------------|
| `--contract <id>` | **(Required)** The contract ID to alert on |
| `--type <type>` | **(Required)** Notification channel: `webhook`, `slack`, `discord`, `telegram`, or `pagerduty` |
| `--url <url>` | Webhook URL (required for `webhook` or `discord`) |
| `--channel <channel>` | Slack or Telegram channel name/ID (required for `slack` or `telegram`) |
| `--routing-key <key>` | PagerDuty integration key (required for `pagerduty`) |
| `--secret <secret>` | HMAC secret for webhook signing (auto-generated if omitted for webhooks) |
| `--threshold <ledgers>` | TTL threshold in number of ledgers (for TTL-based alerts) |
| `--cpu-limit <instructions>`| CPU instruction limit for resource alerts (default: 100,000,000) |
| `--mem-limit <bytes>` | Memory byte limit for resource alerts (default: 50,000,000) |

**Note:** You must specify either `--threshold` (for TTL alerts) or `--cpu-limit`/`--mem-limit` (for resource alerts). You cannot mix them.

#### `alerts list`

List alert configurations for a specific contract.

```bash
sorokeep alerts list --contract <contract-id>
```

#### `alerts remove`

Remove an alert configuration by ID.

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test`

Send a test alert to verify channel connectivity.

```bash
sorokeep alerts test --id <config-id>
```

#### `alerts history`

Show alert history for a contract.

```bash
sorokeep alerts history --contract <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Max number of records to show | `20` |

---

### `sorokeep guard <contract-id>`

Configure auto-extension policies for a contract.

```bash
sorokeep guard <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--target-ttl <ledgers>` | Target TTL in ledgers after extension | `100000` |
| `--threshold <ledgers>` | Extend when TTL drops below this many ledgers | `20000` |
| `--keypair <secret>` | Stellar secret key (for one-time extension) | — |
| `--keypair-env <var>` | Environment variable containing the secret key | — |
| `--auto-extend` | Enable auto-extension (requires `--keypair-env` for the daemon) | — |
| `--dry-run` | Simulate the extension without submitting a transaction | — |
| `--disable` | Disable auto-extension for this contract | — |

---

### `sorokeep costs <contract-id>`

Show rent costs and extension history for a contract.

```bash
sorokeep costs <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--period <days>` | Show costs for the last N days | `30` |
| `--all` | Show all extension history | — |

---

### `sorokeep resources <contract-id>`

Show historical resource usage trends for a contract.

```bash
sorokeep resources <contract-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--period <days>` | Show usage for the last N days | `30` |
| `--all` | Show all resource usage history | — |

---

### `sorokeep restore <contract-id>`

Recover archived entries for a contract.

```bash
sorokeep restore <contract-id> [options]
```

| Option | Description |
|--------|-------------|
| `--keypair <secret>` | Stellar secret key (required) |
| `--keypair-env <var>` | Environment variable containing the secret key (required) |
| `--entry <keyXdr>` | Specific entry key XDR to restore (can be used multiple times) |
| `--all` | Restore all tracked entries for the contract |

**Note:** You must provide either `--keypair` or `--keypair-env`. You must provide either `--entry` or `--all`.

---

### `sorokeep channels`

Manage channel accounts for fee bumping and transaction parallelism.

#### `channels add`

Register a channel account public key.

```bash
sorokeep channels add [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--key <publicKey>` | **(Required)** Stellar public key of the channel account | — |
| `--label <label>` | Optional human-readable label | — |
| `--network <network>` | `testnet` or `mainnet` | `testnet` |

#### `channels list`

List registered channel accounts.

```bash
sorokeep channels list [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--network <network>` | `testnet` or `mainnet` | `testnet` |

#### `channels fund`

Send XLM from a master wallet to all registered channel accounts.

```bash
sorokeep channels fund [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--master-key <secretKey>` | **(Required)** Master wallet secret key (source of funds) | — |
| `--amount <xlm>` | Amount of XLM to send to each channel account | `10` |
| `--network <network>` | `testnet` or `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | Custom Stellar RPC endpoint | Network default |

---

### `sorokeep db`

Backup and restore database state.

#### `db export`

Export tracked database tables as JSON to stdout.

```bash
sorokeep db export
```

#### `db import <file>`

Import tracked database tables from a JSON backup file.

```bash
sorokeep db import <file>
```

---

## Deployment

### Systemd (Linux)

To run the `sorokeep daemon` as a background service on Linux, use a systemd unit file.

**Example `sorokeep-daemon.service`:**

```ini
[Unit]
Description=Sorokeep Monitoring Daemon
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/home/<your-user>/sorokeep
ExecStart=/usr/local/bin/sorokeep daemon --network mainnet --log-format json
Restart=always
Environment=STELLAR_SECRET_KEY=S...
Environment=SOROKEEP_SLACK_TOKEN=xoxb-...

[Install]
WantedBy=multi-user.target
```

1. Copy the service file to `/etc/systemd/system/`.
2. Reload systemd: `sudo systemctl daemon-reload`.
3. Start the service: `sudo systemctl start sorokeep-daemon`.
4. Enable it to start on boot: `sudo systemctl enable sorokeep-daemon`.
```