# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- MCP server permission modes: `mcp.mode` config option, defaulting to `read-only`, which refuses tools not tagged read-only
- Pluggable alert channel registry with built-in channel registration
- Contributor guide for adding new alert channels
- Architecture documentation explaining daemon cycle data flow
- Pull request and issue templates
- CODEOWNERS file with mandatory review on key-handling paths
- Auto-release workflow on version bump

### Changed
- Widen channel_type CHECK constraints for pluggable alert channels
- Source dispatcher's default channel map from the registry
- Move `dispatcher.test.ts` into the active tests/ tree
- Consolidate publish into release workflow

### Fixed
- CRLF-unsafe comment-stripping regex
- Channel_type live migration for existing databases
- Release workflow to use tag-based version detection

## [1.0.0] - 2026-07-10

### Added
- Alert channel registry with five built-in channels (webhook, Slack, Discord, Telegram, PagerDuty)
- Tests for registry-driven CLI channel resolution
- Architecture documentation (ARCHITECTURE.md)
- CODEOWNERS with mandatory review on key-handling paths
- Pull request, bug report, and feature request templates
- Code of conduct and security policy
- Auto-release workflow on version bump

### Changed
- Upgrade @stellar/stellar-sdk from v15 to v16
- Widen channel_type CHECK constraints for pluggable alert channels
- Move pino-pretty to devDependencies
- Remove unnecessary optional dependency

### Fixed
- Error type narrowing in status command catch block
- envelopeXdr type for stellar-sdk v16 GetTransactionResponse
- Unused CostSummary import and sequence type for stellar-sdk v16
- TypeScript type narrowing for StateChangeAlertEvent in template context
- Unnecessary escape lint errors in zsh completion script generation
- Useless assignment lint errors in alert template context builder
- CRLF-unsafe comment-stripping regex in schema migrations
- StopDaemon re-entrance bug
- SQL injection in LIMIT clauses
- Webhook timeout standardization to 10s

### Security
- Fix SQL injection in LIMIT clauses
- Add npm audit step to CI pipeline

## [0.1.2] - 2025-06-15

### Added
- MCP (Model Context Protocol) server with stdio transport
- MCP tools: list_watched_contracts, get_contract_status, get_extension_costs
- Production Docker container with multi-stage build
- Devnet sandbox Docker compose template
- GitLab CI template with sorokeep check command
- Systemd service descriptor for daemon
- ChannelAccountPool for concurrent TTL extensions
- Channels add/list/fund subcommands
- Check command with threshold exit-code and JSON output
- GitHub Actions composite action for TTL checks
- Budget tracking system with SQLite persistence
- Budget configuration and enforcement commands
- AWS Secrets Manager integration for key retrieval
- HashiCorp Vault integration for key retrieval
- Fee bump and sponsorship support
- Adaptive polling intervals with per-contract overrides
- State value diff detection
- History command showing state changes
- Database export and import commands
- Database maintenance commands (vacuum, analyze)
- Schema migration engine
- Resources command
- Inspect command for decoded entry values
- Dry-run flag to guard command
- SCVal-to-JSON type translator
- Config fallback, unwatch, pause/resume monitoring
- Per-contract polling interval overrides
- JSON structured log mode
- Shell completion for bash/zsh
- Rolling average cost anomaly detection
- Rent cost projection model (30/60/90-day windows)
- Resolution notifications when alerts recover
- Alert on resource consumption spikes
- Alert on configured state changes
- Watch command batch file support
- Library API exports (watchContract, runMonitorCycle)
- Bad_sequence error recovery with sequence refresh and retry

### Changed
- Rename project from soroban-sentinel to sorokeep
- Integrate auto-extension into monitor cycle
- Rework ExtendFootprintTTLOp with simulation and fee parsing
- Standardize webhook alert timeout to 10s
- Change no-explicit-any ESLint rule from off to warn
- Use npm ci for deterministic CI builds

### Fixed
- Restore schema.sql and add poll_interval_seconds
- TS compilation errors and ESLint interface errors
- RPC simulation error handling in simulateExtension
- Missing assertSimulationSuccess function
- Duplicate column in schema
- Duplicate submitRestore function
- Budget tracking tests and schema
- Schema corruption and linting bypasses
- Various merge conflict resolutions
- CI build and test errors for cost anomaly detection
- Address CodeRabbit review feedback across multiple modules

### Security
- Mask private keys in all console and log outputs

## [0.1.1] - 2025-05-01

### Fixed
- Add explicit file extensions to imports for ESM compatibility

## [0.1.0] - 2025-04-15

### Added
- Initial project scaffold with TypeScript, Vitest, and ESLint
- SQLite database schema and initialization functions
- Repository access functions for contracts, entries, policies, alerts, and extensions
- StellarRpcClient with health check and contract instance retrieval
- Ledger time formatting and TTL classification utilities
- Logger module with configurable pino-based logging
- Watch command for monitoring Soroban contract TTL
- Daemon loop with re-entrance guard and onCycle hook
- Status command displaying TTL health from DB
- Monitor cycle implementation (Layer 1 of daemon)
- Alert system: webhook, Slack, Discord, Telegram, PagerDuty delivery channels
- Alert dispatcher with delivery tracking (delivered/delivered_at)
- Alerts CLI commands (add, list, remove)
- Alert event types and delivery payload definitions
- Mark alert delivered repository updater
- CI: GitHub Actions for npm publishing to npm and GitHub Packages
- CI: Push/PR workflow for test feedback
- CONTRIBUTING.md with detailed setup and contribution guidelines
- README.md with project overview and usage instructions
- MIT License

### Changed
- Rename binary from sorokeep to sentinel (later reverted)
- Refactor database schema handling to read from schema.sql file
- Various dependency and configuration updates

### Fixed
- TTL classification logic to use strict inequality
- Sentinal database path and configuration
- Package.json files entry and missing CONTRIBUTING.md in files list
- Various formatting and punctuation fixes in docs

[Unreleased]: https://github.com/AbdulmalikAlayande/sorokeep/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AbdulmalikAlayande/sorokeep/releases/tag/v1.0.0

<!--
0.1.0/0.1.1/0.1.2 were real package.json version bumps in this project's
history (see e.g. "chore: bump version to 0.1.2") but were never tagged
as GitHub releases, so no comparison links are included for them here to
avoid pointing at tags that don't exist.
-->
