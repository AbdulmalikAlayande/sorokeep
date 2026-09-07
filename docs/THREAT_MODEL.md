# Sorokeep Threat Model

This document outlines the threat model for Sorokeep. It defines the assets we protect, the trust boundaries of the system, and explicitly out-of-scope threats. It provides context for contributors touching security-sensitive code to ensure consistency with our [Security Policy](../SECURITY.md) and [Architecture](./ARCHITECTURE.md).

## Assets

The primary assets Sorokeep handles and protects include:

- **Secret Keys**: Used for signing transactions (`ExtendFootprintTTLOp`, `RestoreFootprintOp`). Keys may be raw, environment variables, or fetched from AWS Secrets Manager / HashiCorp Vault. These are the most critical assets.
- **Alert Configurations**: Webhook URLs, Slack tokens, and threshold settings stored in the SQLite database (`alert_configs`).
- **Cost Data and Extension History**: Records of extension transactions, their costs, and daily snapshots (`extension_history`, `cost_daily_snapshots`).

## Trust Boundaries & Security Invariants

Sorokeep interacts with several external systems and interfaces. The following are our trust boundaries and the invariants we enforce to maintain them:

- **RPC Endpoint**: Sorokeep relies on a Stellar RPC endpoint to fetch TTLs and simulate/submit transactions.
  - *Threat*: The RPC endpoint might be malicious or compromised.
  - *Invariant*: Sorokeep must not crash, misreport TTLs, or leak secrets due to a malformed or malicious RPC response. Transaction simulation (via RPC `simulateTransaction`) happens before submission for both extension and restore operations — never submit blind.

- **Local Filesystem & Database**: Sorokeep stores its state in a local SQLite database (`~/.sorokeep/sorokeep.db`). We trust the local filesystem's access controls.
  - *Invariant*: Secret keys are **never** written to the SQLite database. Only public keys and, for `keypair-env` mode, the *name* of the environment variable are persisted.
  - *Invariant*: When AWS Secrets Manager or HashiCorp Vault is used for key resolution, the resolved secret must **not** be cached to disk.
  - *Invariant*: Secret keys are **never** logged, including at `debug` level.

- **MCP Clients**: Any connected AI agent or client communicating via the MCP server (`mcp/`).
  - *Threat*: A malicious or compromised AI agent may attempt to extract sensitive data.
  - *Invariant*: MCP tools must strictly limit data exposure and not allow arbitrary execution or secret leakage.

- **Webhook Receivers & Alert Channels**: External services receiving alerts via the dispatcher (`alerts/dispatcher.ts`).
  - *Threat*: Webhook receivers might be slow, fail, or be malicious.
  - *Invariant*: Webhook signature verification (`alerts/webhook.ts`) must prevent HMAC bypass, timing attacks, and replay vulnerabilities.

## Explicit Non-Goals

Sorokeep does **not** defend against the following threats (they are explicitly out of scope):

- **Compromised Host OS**: Vulnerabilities requiring physical or root access to a machine already running Sorokeep. If the underlying OS is compromised, the threat is beyond Sorokeep's ability to mitigate.
- **Pre-leaked Secrets**: Issues that require the user to have already leaked their own secret key outside of Sorokeep.
- **RPC Denial of Service**: Denial of service attacks against the Stellar RPC endpoint itself (not Sorokeep's code).
- **Missing Security Headers**: Missing security headers on documentation sites.
