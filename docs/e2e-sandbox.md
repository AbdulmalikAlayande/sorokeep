# E2E Sandbox Setup

This guide explains how to set up a local end-to-end testing environment for Sorokeep. You will run a local Stellar network, deploy a test contract, and monitor it with Sorokeep — all without touching public testnet or mainnet.

## Prerequisites

- Node.js 22+
- Docker (for running a local Stellar network)
  

## Option 1: Local Stellar Network (Recommended)

The Stellar Quickstart Docker image provides a full Soroban-enabled test network in a single container.

### 1. Start the local network

```bash
docker run --rm -it \
  -p 8000:8000 \
  --name soroban-local \
  stellar/quickstart:soroban-dev@sha256:9f5c75ce2e920a9b9a6e7e8d0b3a2c8f6e9b7c5d4a3b2c1d0e9f8a7b6c5d4e3f \
  --local \
  --enable-soroban-rpc
```

The Soroban RPC will be available at `http://localhost:8000/soroban/rpc`.

### 2. Create and fund a test account

Install the Stellar CLI:

```bash
# Install the Stellar CLI
cargo install --locked stellar-cli

# Or use the Docker image
alias stellar="docker run --rm -it --network host stellar/stellar-cli"
```

Create a keypair:

```bash
stellar keys generate sorokeep-test --fund
```

This generates a keypair and funds it from the local network's friendbot.

### 3. Deploy a test contract

```bash
# Build the hello-world example contract
git clone https://github.com/stellar/soroban-examples.git
cd soroban-examples/hello_world
stellar contract build

# Deploy to the local network
WASM_FILE="target/wasm32-unknown-unknown/release/soroban_hello_world_contract.wasm"
stellar contract deploy \
  --wasm $WASM_FILE \
  --source sorokeep-test \
  --network local
```

Save the deployed contract ID — you'll use it with Sorokeep.

### 4. Configure Sorokeep for the local network

```bash
# Point Sorokeep at your local network
npx tsx src/index.ts watch <CONTRACT_ID> \
  --rpc-url http://localhost:8000/soroban/rpc \
  --name "Hello World (Local)"
```

### 5. Run the daemon

```bash
npx tsx src/index.ts daemon \
  --rpc-url http://localhost:8000/soroban/rpc \
  --interval 10000
```

The daemon polls every 10 seconds and reports TTL health for your local contract.

### 6. (Optional) Trigger TTL changes

To simulate TTL changes, you can advance the local network ledger:

```bash
stellar lab close-ledger
```

This closes the current ledger and advances to the next one, decrementing TTLs. Run it several times to watch the monitoring pick up the changes.

## Option 2: Testnet Sandbox

If Docker is not available, you can use Stellar's public testnet.

### 1. Fund a test account

Use the [Stellar Laboratory Friendbot](https://laboratory.stellar.org/#account-creator?network=testnet) or the Stellar CLI:

```bash
stellar keys generate sorokeep-test --fund --network testnet
```

### 2. Deploy via existing Soroban testnet contracts

Sorokeep can monitor any contract already deployed on testnet. Use a known contract:

```bash
# XLM Native Token on testnet
npx tsx src/index.ts watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token (Testnet)"
```

Or deploy your own:

```bash
# Deploy from soroban-examples
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/soroban_hello_world_contract.wasm \
  --source sorokeep-test \
  --network testnet
```

### 3. Run the daemon

```bash
npx tsx src/index.ts daemon --network testnet
```

## Option 3: Automated E2E Test Script

For CI or repeatable testing, use the following script:

```bash
#!/usr/bin/env bash
# scripts/e2e-local.sh
set -euo pipefail

echo "=== Starting local Stellar network ==="
docker run --rm -d \
  -p 8000:8000 \
  --name soroban-local \
  stellar/quickstart:soroban-dev@sha256:9f5c75ce2e920a9b9a6e9b7c5d4a3b2c1d0e9f8a7b6c5d4e3f \
  --local \
  --enable-soroban-rpc

# Wait for the RPC to be ready
echo "=== Waiting for RPC... ==="
for i in $(seq 1 30); do
  if curl -s http://localhost:8000/soroban/rpc -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' > /dev/null 2>&1; then
    echo "RPC ready"
    break
  fi
  sleep 1
done

echo "=== Creating test account ==="
stellar keys generate e2e-test --fund --network local

echo "=== Deploying test contract ==="
# (clone and build soroban-examples if not present)
CONTRACT_ID=$(stellar contract deploy \
  --wasm /path/to/hello_world.wasm \
  --source e2e-test \
  --network local)

echo "Contract ID: $CONTRACT_ID"

echo "=== Running Sorokeep watch ==="
npx tsx src/index.ts watch "$CONTRACT_ID" \
  --rpc-url http://localhost:8000/soroban/rpc \
  --name "E2E Test Contract"

echo "=== Running Sorokeep status ==="
npx tsx src/index.ts status "$CONTRACT_ID"

echo "=== Running daemon (3 cycles) ==="
timeout 35 npx tsx src/index.ts daemon \
  --rpc-url http://localhost:8000/soroban/rpc \
  --interval 10000 || true

echo "=== Cleaning up ==="
docker stop soroban-local

echo "=== E2E test complete ==="
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Docker container exits immediately | Ensure you're using the `soroban-dev` tag and have enabled `--enable-soroban-rpc` |
| RPC connection refused | The container takes 5-10 seconds to start. Wait and retry. |
| `stellar keys generate --fund` fails on local | The local friendbot runs on port 8000. Ensure the container is healthy. |
| Contract deploy fails | Build the WASM file first with `stellar contract build` |
| Sorokeep timeout | Increase `--interval` (e.g. 300000 for 5 minutes) or check RPC URL |
| Duplicate contract ID | Each deploy generates a unique contract ID. Save the output from `stellar contract deploy`. |

## Verification Checklist

After completing the sandbox setup, verify the following:

- [ ] `sorokeep status <contract-id>` shows entries with TTL values
- [ ] `sorokeep guard <contract-id> --dry-run` estimates fee without submitting
- [ ] `sorokeep alerts add --type webhook ...` creates an alert config
- [ ] Running `sorokeep daemon` for several cycles does not crash
- [ ] After advancing the ledger, `status` reflects updated TTLs
