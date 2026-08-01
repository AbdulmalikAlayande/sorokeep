# Security Policy

Sorokeep resolves Stellar secret keys, submits signed transactions (`ExtendFootprintTTLOp`, `RestoreFootprintOp`), and can be configured to spend real XLM autonomously via the daemon's auto-extension guard. Treat vulnerability reports here with the same urgency you'd give a wallet or key-management tool — because that's effectively what parts of this codebase are.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/AbdulmalikAlayande/sorokeep/security/advisories/new) for this repository. This is the preferred channel — it lets us discuss, patch, and coordinate a disclosure timeline before the issue is public.

Include:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is ideal)
- The affected version(s) or commit
- Whether the issue is exploitable remotely, requires local access, or requires a specific configuration (e.g., `--auto-extend` enabled)

You should receive an acknowledgment within 5 business days. We'll keep you updated as we investigate and patch.

## Scope

The following are in scope for security reports:

- **Key handling** — any path where a secret key (raw, env-var, AWS Secrets Manager, or HashiCorp Vault-resolved) could be logged, persisted to disk, or leaked in an error message
- **Transaction construction** — bugs in `core/extension.ts`, `core/status.ts` (restore), or the channel account pool (`core/channels.ts`) that could cause unintended transactions, incorrect amounts, or fee miscalculation
- **Webhook signature verification** (`alerts/webhook.ts`) — HMAC bypass, timing attacks, replay vulnerabilities
- **SQL injection or unsafe query construction** in `db/repositories.ts`
- **RPC response trust boundaries** — if a malicious or compromised RPC endpoint response could cause sorokeep to misreport TTLs, skip an extension, or crash the daemon
- **MCP server** (`mcp/`) — any tool that exposes more data than intended to a connected AI agent/client
- **Dependency vulnerabilities** with a real exploitation path in sorokeep's usage (not just a CVE ID with no relevant code path)

## Out of Scope

- Vulnerabilities requiring physical access to a machine already running sorokeep with a compromised OS
- Issues that require the user to have already leaked their own secret key outside of sorokeep
- Denial of service against a Stellar RPC endpoint itself (not sorokeep's code)
- Missing security headers on documentation sites

## Supported Versions

Only the latest published version on npm receives security patches. Sorokeep is pre-1.x-stabilization; there is no long-term support branch yet. If this changes as the project matures, this table will be updated.

| Version | Supported |
|---------|-----------|
| Latest (npm `latest` tag) | Yes |
| Older releases | No |

## Key Handling Principles (for reviewers and contributors)

These are the invariants any PR touching secret-key code paths must preserve:

1. Secret keys are never written to the SQLite database. Only public keys and, for `keypair-env` mode, the *name* of the environment variable are persisted.
2. Secret keys are never logged, including at `debug` level.
3. When AWS Secrets Manager or HashiCorp Vault is used for key resolution, the resolved secret must not be cached to disk.
4. Transaction simulation (via RPC `simulateTransaction`) happens before submission for both extension and restore operations — never submit blind.

If a PR changes any code path touching secret keys or transaction submission, call this out explicitly in the PR description so reviewers know to scrutinize it.

## Postmortem Template

After any security incident involving sorokeep (secret-key leak, webhook bypass, RPC trust-boundary abuse, etc.), file a postmortem using the [incident postmortem template](docs/postmortem-template.md). The template includes sorokeep-specific diagnostic prompts for daemon logs, alert history, and cost analysis.
