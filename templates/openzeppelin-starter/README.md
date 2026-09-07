# OpenZeppelin Soroban Starter Template

This template provides a minimal, working Soroban smart contract using the [OpenZeppelin Stellar Contracts](https://docs.openzeppelin.com/stellar-contracts) library (specifically, `Ownable`), along with a pre-configured `sorokeep` setup.

Sorokeep helps you monitor your deployed contract and automatically bump its TTL (Time-To-Live) on the Stellar network so it doesn't get archived.

## 1. Prerequisites

- [Rust](https://www.rust-lang.org/tools/install)
- [Soroban CLI](https://soroban.stellar.org/docs/getting-started/setup)
- [Sorokeep](https://github.com/AbdulmalikAlayande/sorokeep) (installed globally, e.g. `npm link` after building from source — see the main README)

## 2. Build the Contract

```bash
cargo build --target wasm32-unknown-unknown --release
```

## 3. Deploy to Testnet

Make sure your Soroban CLI is configured for Testnet and you have an identity.

```bash
soroban keys generate --network testnet my-key
```

Deploy the contract:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/openzeppelin_starter.wasm \
  --source my-key \
  --network testnet
```

Take note of the output **Contract ID** (e.g., `C...`).

## 4. Sorokeep Configuration

Edit `sorokeep.config.yaml` to use your deployed Contract ID:

```yaml
contracts:
  - contractId: YOUR_CONTRACT_ID
    name: openzeppelin-starter
    network: testnet
```

## 5. Using Sorokeep

### Watch

Register the contract(s) listed in the manifest for monitoring:

```bash
sorokeep watch --from-file sorokeep.config.yaml
```

Check current TTL health at any time (reads the local database, no RPC call):

```bash
sorokeep status YOUR_CONTRACT_ID
```

### Guard

Enable auto-extension so the daemon extends the TTL automatically once it drops below a threshold:

```bash
sorokeep guard YOUR_CONTRACT_ID \
  --keypair-env STELLAR_SECRET_KEY \
  --auto-extend \
  --target-ttl 100000 \
  --threshold 20000
```

Then start the daemon to act on it:

```bash
sorokeep daemon --network testnet
```

## 6. GitHub Actions (CI)

This template includes a `.github/workflows/sorokeep-check.yml` workflow using sorokeep's official [`sorokeep check` GitHub Action](https://github.com/AbdulmalikAlayande/sorokeep/blob/main/action.yml) to fail CI if your contract's TTL drops below a threshold before a deploy. Update the `contract-id` input with your deployed Contract ID.
