import fs from "fs";
import { execSync } from "child_process";
import readline from "readline";

// ─── Programmatic Issue Builder ──────────────────────────────────────────────

function getResources(area) {
    let resources = [
        "- [Stellar Developers Documentation](https://developers.stellar.org/docs)",
        "- [Soroban Smart Contracts Documentation](https://soroban.stellar.org/docs)"
    ];
    if (area === "db") {
        resources.push("- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)");
    } else if (area === "alerts") {
        resources.push("- [Slack Block Kit Builder](https://app.slack.com/block-kit-builder)");
        resources.push("- [Discord Webhook Documentation](https://discord.com/developers/docs/resources/webhook)");
    } else if (area === "core") {
        resources.push("- [Stellar JavaScript SDK](https://github.com/stellar/js-stellar-sdk)");
        resources.push("- [Soroban RPC API Reference](https://soroban.stellar.org/api/methods)");
    } else if (area === "cli") {
        resources.push("- [Commander.js Documentation](https://github.com/tj/commander.js)");
    } else if (area === "daemon") {
        resources.push("- [Node.js Event Loop and Timers](https://nodejs.org/en/docs/guides/timers-in-node/)");
    }
    resources.push("- [Test-Driven Development (TDD) Guide](https://martinfowler.com/bliki/TestDrivenDevelopment.html)");
    return resources.join("\n");
}

function createIssue(title, complexity, area, phase, context, requirements, techNotes, criteria) {
    return {
        title,
        complexity,
        area,
        phase: `phase-${phase}`,
        body: `## 🎯 Context & Objective
${context}

## 📝 Implementation Plan
${requirements.map((r, i) => `${i + 1}. **Step ${i + 1}**: ${r}`).join("\n")}

## 🧪 Test-Driven Development (TDD) Requirements
**🚨 IMPORTANT:** We enforce strict Test-Driven Development. You must write your tests *before* implementing the logic.
Your Pull Request will not be accepted without comprehensive tests.

- [ ] **Setup Test Environment**: Create or locate the relevant test file.
- [ ] **Write Failing Tests First**: Based on the Acceptance Criteria, write your tests.
- [ ] **Implementation**: Implement the logic to make the tests pass.
- [ ] **Edge Cases**: Ensure you have tested edge cases and failure modes.

**Specific Test Criteria:**
${criteria.map(c => `- ${c}`).join("\n")}

## 🛠️ Technical Notes
${techNotes}

## 📚 Learning Resources & References
${getResources(area)}

## ✅ Acceptance Criteria
${criteria.map(c => `- [ ] ${c}`).join("\n")}`
    };
}

const issues = [];

// --- Phase 1: Complete the Core (Issues 1-25) ---
issues.push(createIssue(
    "feat(db): add delivered/delivered_at columns to alerts_fired table",
    "trivial", "db", 1,
    "The monitor cycle detects threshold crossings. To implement Option B delivery, we must track which alert events have already been sent to notification channels.",
    ["Add 'delivered' (INTEGER, default 0) and 'delivered_at' (TEXT, nullable) to schema.sql.", "Implement getUndeliveredAlerts, markAlertDelivered, countUndeliveredAlerts in repositories.ts.", "Add unit tests for all repository updates."],
    "Look at src/db/schema.sql and src/db/repositories.ts. Use standard SQLite datetime functions.",
    ["Database schema includes new columns.", "Tests verify that marked alerts do not show up in getUndeliveredAlerts."]
));
issues.push(createIssue(
    "feat(alerts): implement AlertChannel interface and dispatcher core",
    "high", "alerts", 1,
    "We need a central dispatcher to process pending notifications, route them by channel type, and isolate errors so one failing channel doesn't block others.",
    ["Define AlertChannel interface with send(event: AlertEvent) method.", "Implement deliverPendingAlerts(db, network) in dispatcher.ts.", "Mark alerts as delivered on success, increment retry/failure counters on error.", "Ensure full isolation: if Webhook fails, Slack should still proceed."],
    "Create src/alerts/dispatcher.ts. Inject mock channels in tests to verify routing and error boundaries.",
    ["deliverPendingAlerts loops through all pending alerts.", "Failing channels do not crash the loop.", "Successful dispatches are updated in DB."]
));
issues.push(createIssue(
    "feat(alerts): implement webhook delivery channel",
    "medium", "alerts", 1,
    "Allows users to register external HTTP endpoints to receive structured alert payloads when TTL boundaries are crossed.",
    ["Implement WebhookChannel class matching the AlertChannel interface in src/alerts/webhook.ts.", "Send HTTP POST with JSON body matching AlertEvent format.", "Configure default 5-second timeout.", "Verify response is 2xx; throw error on 4xx/5xx or timeout.", "Write tests using mocked global fetch."],
    "Use Node.js native fetch. Check how timeout abort signals are generated.",
    ["HTTP POST sent with correct headers and JSON body.", "Network timeout is handled and triggers failure.", "200 OK marks delivery as successful."]
));
issues.push(createIssue(
    "feat(alerts): implement Slack delivery channel",
    "medium", "alerts", 1,
    "Deliver human-readable warning and recovery messages to Slack channels.",
    ["Implement SlackChannel class in src/alerts/slack.ts.", "Format AlertEvent into Slack Block Kit payload.", "POST payload to Slack incoming webhook URL.", "Write test suite verifying Block Kit payload construction."],
    "Read Slack Block Kit guidelines. Place warning values in side fields for scannability.",
    ["Valid Slack webhook call returns success.", "Message contains contract ID, TTL, threshold, and severity details."]
));
issues.push(createIssue(
    "feat(daemon): integrate alert delivery into daemon loop",
    "medium", "daemon", 1,
    "The monitoring daemon needs to dispatch notifications immediately after completing its polling cycles.",
    ["Import deliverPendingAlerts inside src/daemon/loop.ts.", "Call the delivery dispatcher immediately after runMonitorCycle completes.", "Handle and log delivery report summaries in stdout/logs.", "Add daemon integration tests verifying dispatcher is invoked."],
    "Look at executeCycle() in src/daemon/loop.ts. Make sure database instances are shared correctly.",
    ["Running daemon cycle triggers alert dispatch.", "Fired alerts are successfully dispatched and marked delivered during the cycle."]
));
issues.push(createIssue(
    "feat(cli): implement alerts add/list/remove commands",
    "medium", "cli", 1,
    "Provide a CLI interface for users to configure alert channels and thresholds for watched contracts.",
    ["Register subcommands under 'alerts' in src/commands/alerts.ts.", "Implement add: --contract, --type, --url/--channel, --threshold.", "Implement list: show formatted table of configurations per contract.", "Implement remove: delete config by ID.", "Write CLI command tests verifying DB actions and inputs."],
    "Use Commander.js subcommands. Leverage existing database repositories.",
    ["'sorokeep alerts add' writes config to SQLite.", "'sorokeep alerts list' prints a clean console table.", "'sorokeep alerts remove' deletes from DB."]
));
issues.push(createIssue(
    "test(alerts): add integration test for full alert lifecycle",
    "medium", "tests", 1,
    "Ensure the entire pipeline from TTL discovery to alert delivery works cohesively.",
    ["Write E2E-style test in tests/alerts/lifecycle.test.ts.", "Register a contract, configure a Slack alert.", "Mock RPC returning a critical TTL.", "Run monitor cycle (assert alert written to DB).", "Run delivery cycle (assert webhook called and DB updated)."],
    "Use getDatabaseForTesting() for a clean, in-memory SQLite run.",
    ["Test suite runs successfully with zero external dependencies.", "Verifies all DB states transition correctly."]
));
issues.push(createIssue(
    "feat(core): implement transaction building for ExtendFootprintTTLOp",
    "high", "core", 1,
    "Auto-extension requires building and submitting ExtendFootprintTTLOp transactions to extend ledger entry lifetimes.",
    ["Create transaction builder utility in src/core/extension.ts.", "Simulate transaction using RPC to estimate resource fees.", "Assemble transaction with ExtendFootprintTTLOp using target ledger keys as read footprint.", "Sign transaction with secret key and submit to network.", "Return tx hash, actual fee paid, and new ledger boundaries."],
    "Use @stellar/stellar-sdk. Check how footprints are constructed for contract instances vs WASM codes.",
    ["Simulates footprint before building.", "Submits transaction and parses transaction results for fee details."]
));
issues.push(createIssue(
    "feat(core): implement transaction building for RestoreFootprintOp",
    "high", "core", 1,
    "When contract storage is archived, we need to build and submit RestoreFootprintOp transactions to recover it.",
    ["Create restore transaction builder in src/core/extension.ts.", "Simulate transaction using RPC to estimate required fee.", "Assemble RestoreFootprintOp using archived keys as write footprint.", "Sign with secret key, submit, and parse results.", "Write tests with mocked RPC client."],
    "Refer to ExtendFootprint transaction structure. Restore footprint keys must go in the write footprint.",
    ["Restores archived ledger entries.", "Extracts resource fee and status parameters from response."]
));
issues.push(createIssue(
    "feat(core): integrate auto-extension into monitor cycle",
    "high", "core", 1,
    "The daemon cycle must automatically trigger extensions when monitored TTLs cross configured thresholds.",
    ["Check extension_policies table during monitor cycle execution.", "If policy exists and enabled, and current TTL is below threshold, trigger transaction builder.", "Save submission logs to extension_history database table.", "Gracefully handle failures (insufficient funds, bad sequence) without stopping the daemon."],
    "Look at src/core/monitor.ts. Ensure database writes are committed on success.",
    ["Daemon detects low TTL, executes transaction, and records details in extension_history."]
));
issues.push(createIssue(
    "feat(cli): implement guard command",
    "medium", "cli", 1,
    "Allow developers to configure and enable auto-extension policies for their watched contracts.",
    ["Implement 'guard' CLI command in src/commands/guard.ts.", "Support options: --target-ttl, --extend-below, --keypair-env, --auto-extend, --disable.", "Validate input ranges (threshold must be less than target TTL).", "Extract public key from secret at setup to avoid storing secrets in DB.", "Write CLI command tests."],
    "Use Commander.js command registration. Save policies to SQLite.",
    ["'sorokeep guard <contractId> --auto-extend' registers policy.", "Only public key is saved in SQLite database."]
));
issues.push(createIssue(
    "feat(cli): implement restore command",
    "medium", "cli", 1,
    "Provide a CLI command to manually trigger restoration for archived contract entries.",
    ["Implement 'restore' command in src/commands/restore.ts.", "Support flags: --entry (key XDR), --keypair-env.", "Retrieve archived entry from RPC, build RestoreFootprintOp, submit and print transaction result."],
    "Check how commander options resolve keypair from environment variables.",
    ["'sorokeep restore <contractId>' builds and submits restore transaction.", "Outputs transaction hash and fee spent on success."]
));
issues.push(createIssue(
    "feat(cli): implement costs command",
    "medium", "cli", 1,
    "Report total XLM spent on state extensions and project future rent costs.",
    ["Implement 'costs' CLI command in src/commands/costs.ts.", "Query extension_history table for a contract.", "Calculate total spent over past 7, 30, and 90 days.", "Generate 30-day projected cost based on current entry state.", "Print a clean, structured table in terminal."],
    "Combine historical DB costs with live RPC fee stats.",
    ["Command displays historical costs table.", "Displays a valid 30-day projection estimate."]
));
issues.push(createIssue(
    "feat(cli): implement unwatch command",
    "medium", "cli", 1,
    "Provide a command to remove registered contracts and clean up all associated logs.",
    ["Implement 'unwatch' CLI command in src/commands/watch.ts.", "Delete contract row from SQLite database.", "Ensure foreign key constraints CASCADE delete policies, alerts, and histories.", "Add a confirmation prompt unless --yes flag is passed."],
    "Verify PR foreign keys are enabled: 'PRAGMA foreign_keys = ON' on SQLite connection.",
    ["'sorokeep unwatch <contractId>' removes contract.", "All cascade dependencies are removed from SQLite database."]
));
issues.push(createIssue(
    "feat(cli): add pause/resume monitoring per contract",
    "trivial", "cli", 1,
    "Allow developers to temporarily pause daemon alerts and auto-extensions without unwatching the contract.",
    ["Add 'active' (INTEGER, default 1) column to contracts table in schema.sql.", "Implement 'pause' and 'resume' subcommands in CLI.", "Update daemon monitor loop to skip inactive contracts."],
    "Update repositories.ts queries to filter or return active state.",
    ["'sorokeep pause' updates status in DB.", "Daemon skips polling/alerting for paused contracts."]
));
issues.push(createIssue(
    "feat(cli): support batch watch via config file",
    "medium", "cli", 1,
    "Allow registering multiple contracts at once from a configuration file.",
    ["Add '--from-file <path>' option to watch command.", "Load contract configurations from YAML/JSON file.", "Loop and register each contract on its respective network.", "Output batch summary of success/failure."],
    "Reuse the watchContract core logic to avoid duplicate code.",
    ["'sorokeep watch --from-file contracts.yaml' registers all listed contracts.", "Prints clear summary table."]
));
issues.push(createIssue(
    "feat(cli): add alert verification test command",
    "trivial", "cli", 1,
    "Provide a CLI command to test webhook or Slack alert configurations.",
    ["Implement 'alerts test <configId>' subcommand.", "Query alert configuration from DB.", "Generate a mock 'threshold_crossed' AlertEvent and submit to the dispatcher.", "Print success/failure report in console."],
    "Use existing dispatcher delivery logic.",
    ["Command triggers dispatcher.", "Test message delivered successfully to configured Slack/webhook."]
));
issues.push(createIssue(
    "feat(cli): add database export/import utility",
    "medium", "cli", 1,
    "Allow backing up and restoring database state.",
    ["Implement 'db export' and 'db import' commands.", "Export: serialize all tables (except histories) to JSON stdout.", "Import: read JSON file, clear existing tables, and load data inside transaction."],
    "Ensure table data loading respects foreign key ordering.",
    ["db export outputs valid JSON.", "db import restores watched contracts and alert policies successfully."]
));
issues.push(createIssue(
    "feat(core): add config file support (config.yaml)",
    "medium", "core", 1,
    "Allow configuring default daemon intervals, networks, and RPC overrides in a persistent configuration file.",
    ["Read configuration from ~/.sorokeep/config.yaml.", "Define default values for pollingIntervalSeconds, default network, and logging levels.", "Allow CLI options to override configuration parameters."],
    "Use YAML package to parse configuration. Ensure config directories are initialized safely.",
    ["Daemon respects pollingIntervalSeconds from config.", "CLI flags override YAML configurations."]
));
issues.push(createIssue(
    "fix(core): resolve alerts per alert_config_id not per entry_id",
    "trivial", "core", 1,
    "Currently, resolveAlerts resolves all configured alerts for an entry, which is incorrect if multiple thresholds exist.",
    ["Modify resolveAlerts repository function to accept alertConfigId.", "Update monitor.ts resolve sequence.", "Update unit tests verifying correct configurations are resolved."],
    "Look at src/db/repositories.ts and src/core/monitor.ts.",
    ["Extending TTL resolves only the alert config that breached, leaving others intact.", "Unit tests pass."]
));
issues.push(createIssue(
    "feat(cli): add --json output flag to status and costs commands",
    "trivial", "cli", 1,
    "Make command outputs machine-readable for integrations, dashboards, and automated scripts.",
    ["Add '--json' option to status and costs commands.", "Serialize payload data to structured JSON string on stdout.", "Mute terminal styles and spinners when --json is enabled."],
    "Ensure JSON structure contains all properties displayed in tables.",
    ["'sorokeep status <contractId> --json' prints valid JSON.", "Standard console output matches table layout."]
));
issues.push(createIssue(
    "feat(cli): add shell completion for bash/zsh",
    "trivial", "cli", 1,
    "Improve CLI UX by adding shell autocompletion for commands, options, and contract IDs.",
    ["Build shell autocompletion generator using Commander.js.", "Add completion scripts for zsh and bash.", "Autocomplete watched contract IDs from the local SQLite database."],
    "Query database dynamically inside completion hook.",
    ["Pressing tab after 'status' lists watched contract IDs.", "Pressing tab lists all subcommands."]
));
issues.push(createIssue(
    "feat(daemon): add structured JSON log mode",
    "trivial", "daemon", 1,
    "Daemon logs should support structured JSON format for log aggregators.",
    ["Add '--log-format json' option to daemon command.", "Configure Pino logger to print JSON lines instead of pretty formatting.", "Include component, level, and timestamp fields in JSON structure."],
    "See src/logging/index.ts and logger configuration options.",
    ["Daemon prints structured JSON when option enabled.", "Logs can be parsed by jq successfully."]
));
issues.push(createIssue(
    "feat(cli): add --dry-run flag to guard command",
    "trivial", "cli", 1,
    "Allow dry-running auto-extension configuration to check costs without committing on-chain transactions.",
    ["Add '--dry-run' option to guard command.", "Invoke simulateExtension with target key footprint.", "Print estimated fees and extended TTL ledgers."],
    "Reuse core simulation logic in src/core/extension.ts.",
    ["'sorokeep guard <id> --dry-run' returns simulation results.", "Does not submit transaction on-chain."]
));
issues.push(createIssue(
    "docs: write complete CLI reference manual",
    "trivial", "docs", 1,
    "Ensure developers have complete CLI manuals, setups, and workflows documented.",
    ["Create CLI.md manual in docs/ directory.", "Document every command, argument, option, and environment variables.", "Add quick-start guides and real-world deployment scripts."],
    "Audit all commands to ensure flags align with documentation.",
    ["Documentation is comprehensive and matches code features.", "All hyperlinks are validated."]
));

// --- Phase 2: Developer Experience & Safety (Issues 26-45) ---
issues.push(createIssue(
    "feat(core): parse resource limits from simulateTransaction response",
    "medium", "core", 2,
    "Extract estimated resource usage variables to allow budget safety limits checks before executing auto-extensions.",
    ["Parse raw simulation results structure returned by getTransactions or simulateTransaction.", "Extract cpuInstructions, memoryBytes, and transaction minResourceFee.", "Return structured ResourceEstimate object containing all fields.", "Write tests with mocked simulation JSON results."],
    "Look at simulateTransaction in src/rpc/client.ts.",
    ["Extracts resource usage parameters correctly.", "Unit tests cover successful simulation parsing and error cases."]
));
issues.push(createIssue(
    "feat(cli): display gas and resource limits in simulation output",
    "trivial", "cli", 2,
    "Format and display transaction resource footprint stats during dry-runs.",
    ["Update simulation CLI reporting interface.", "Format CPU instructions, memory bytes, and read/write sizes.", "Show final fee estimations in XLM."],
    "Use table structure or bullet lists for CLI presentation.",
    ["CLI prints resource limits cleanly.", "Shows correct conversion from Stroops to XLM."]
));
issues.push(createIssue(
    "feat(core): cache simulation results for unchanged footprints",
    "medium", "core", 2,
    "Cache transaction simulations locally to prevent redundant RPC traffic for static footprints.",
    ["Create an in-memory or database simulation cache.", "Key cache entries on contract footprint hashes.", "Invalidate cache when the contract WASM or instance changes."],
    "Check how footprint hashes are computed in src/core/discovery.ts.",
    ["Returns cached resource estimates on duplicate calls.", "Cache invalidates when footprints modify."]
));
issues.push(createIssue(
    "feat(core): implement retry with exponential backoff for RPC calls",
    "medium", "core", 2,
    "Implement retry policies to recover from temporary RPC dropouts.",
    ["Build a wrapper function for executing RPC actions.", "Retry on HTTP 429 (Too Many Requests), 5xx, or network timeouts.", "Implement exponential backoff starting at 1 second, doubling up to 3 retries."],
    "Integrate inside the core rpc/client.ts wrapper.",
    ["Network timeouts trigger retry attempts.", "Succeeds if transient failure resolves within retries."]
));
issues.push(createIssue(
    "test(core): add edge case tests for simulation failures",
    "medium", "tests", 2,
    "Ensure the system safely handles a wide variety of simulation failure states.",
    ["Mock simulateTransaction failures in tests.", "Test: invalid footprint keys, expired sequence numbers, and insufficient wallet balances.", "Ensure each failure throws a distinct, readable error."],
    "Look at existing mock patterns in tests/core/monitor.test.ts.",
    ["All mock failure test cases run and verify correct warning logs are generated."]
));
issues.push(createIssue(
    "feat(db): add budget_tracking table to SQLite",
    "trivial", "db", 2,
    "Create database tables to store monthly spending budgets per contract for safety constraints.",
    ["Define budget_tracking table in schema.sql with contract_id, limit_xlm, spent_xlm, and billing_cycle fields.", "Add CRUD functions in repositories.ts to retrieve and update budget spent totals."],
    "Refer to SQLite schema standards in src/db/schema.sql.",
    ["Migration or schema creation works without SQL syntax errors.", "Database tracking functions pass unit tests."]
));
issues.push(createIssue(
    "feat(core): enforce budget limits before auto-extension",
    "high", "core", 2,
    "Verify the monthly XLM budget limits are checked and enforced before executing any auto-extension transactions.",
    ["Query remaining budget before signing any ExtendFootprint transaction.", "Block the transaction and trigger alert if estimate exceeds remaining budget.", "Add transaction fee to spent balance in database after success."],
    "Integrate this logic inside executeCycle in src/daemon/loop.ts or src/core/extension.ts.",
    ["Extensions are skipped when budget limit is crossed.", "Database records spend history correctly."]
));
issues.push(createIssue(
    "feat(cli): add budget configuration commands",
    "medium", "cli", 2,
    "Add CLI commands for users to configure monthly spending bounds.",
    ["Add 'budget' subcommands: `sorokeep budget set --contract <id> --limit <xlm>`.", "Add status command: `sorokeep budget status <contractId>`."],
    "Use Commander.js command registration.",
    ["Budget configurations are written to DB.", "Status command displays current spend progress bar."]
));
issues.push(createIssue(
    "feat(alerts): dispatch notification on budget exhaustion",
    "trivial", "alerts", 2,
    "Alert configurations should receive notifications when a contract's auto-extension budget has run out.",
    ["Define 'budget_exhausted' AlertEvent schema.", "Fire an event to configured alert channels when budget checks block auto-extensions."],
    "Ensure dispatcher receives the budget exhaustion event context.",
    ["Webhooks and Slack receive a warning notification on budget exhaustion."]
));
issues.push(createIssue(
    "feat(core): implement auto-extension rate limiter",
    "medium", "core", 2,
    "Implement rate-limits to prevent runaway loops of transaction fee submissions under extreme network loads.",
    ["Build a rate limiter checking transaction history.", "Enforce a maximum limit of N auto-extension transactions per hour (default 5).", "Block extensions if rate limit is reached."],
    "Use repositories.ts queries to count transaction logs in the past hour.",
    ["Rate limiter blocks consecutive transactions exceeding hourly limit.", "Sends alert on rate limit blockages."]
));
issues.push(createIssue(
    "feat(core): implement key resolution chain (env → keychain → file)",
    "high", "core", 2,
    "Build a robust resolver pipeline to securely fetch keys from multiple sources without leaking credentials.",
    ["Define KeyResolver interface in src/core/keyring.ts.", "Implement resolvers for environment variables, OS keychains, and local encrypted configurations.", "Fallback gracefully to the next provider in sequence."],
    "See how keys are resolved in src/commands/guard.ts.",
    ["Keys resolve correctly from process.env when configured.", "Validates signature capabilities of resolved keys."]
));
issues.push(createIssue(
    "feat(core): integrate system keychain for key storage",
    "medium", "core", 2,
    "Integrate local OS keychains (macOS Keychain/Windows Credential Manager) to store extension keypairs securely.",
    ["Use keytar package to write and read from local OS credentials manager.", "Implement CLI command: `sorokeep keys add --name <name>` prompting securely for private key."],
    "Add keytar dependency in package.json.",
    ["Secret key is successfully saved in system credentials database.", "CLI command lists key labels without showing values."]
));
issues.push(createIssue(
    "feat(core): integrate HashiCorp Vault for key retrieval",
    "medium", "core", 2,
    "Retrieve Stellar secret keys dynamically from a HashiCorp Vault server.",
    ["Build a Vault resolver class querying Vault API.", "Configure Vault URL and authentication tokens in config.yaml."],
    "Check how config file variables are loaded.",
    ["Fetches valid secret keys from Vault endpoint.", "Raises error on invalid authentication credentials."]
));
issues.push(createIssue(
    "feat(core): integrate AWS Secrets Manager for key retrieval",
    "medium", "core", 2,
    "Retrieve Stellar secret keys dynamically from AWS Secrets Manager.",
    ["Build an AWS Secrets resolver class.", "Initialize AWS Secrets Client using standard IAM profile credentials."],
    "Ensure AWS SDK imports are imported lazily to keep footprint light.",
    ["Resolves keys correctly from AWS Secrets Manager when credentials match."]
));
issues.push(createIssue(
    "fix(cli): mask private keys in all console and log outputs",
    "trivial", "cli", 2,
    "Harden security logs to ensure private keys are never printed in cleartext to logs or terminals.",
    ["Audit log statements across commands and core modules.", "Replace any potential raw private key string output with a masked string displaying only the first and last 4 characters."],
    "Implement a general key-mask helper utility in src/utils/formatting.ts.",
    ["Masked key format (e.g. SAAA...XYZ) is displayed in all logs instead of raw secret key."]
));
issues.push(createIssue(
    "feat(daemon): implement adaptive polling intervals",
    "high", "daemon", 2,
    "Replace static daemon intervals with adaptive cycles based on the remaining lifetime of watched contract entries.",
    ["Calculate next polling checks dynamically per contract.", "If TTL is > 7 days, check hourly. If < 24 hours, check every 5 minutes. If < 1 hour, check every minute.", "Reschedule loop timer dynamically based on the lowest calculated interval."],
    "Look at src/daemon/loop.ts scheduling configurations.",
    ["Daemon runs checks more frequently as critical expiration approaches.", "Polls less frequently when TTLs are safe."]
));
issues.push(createIssue(
    "feat(cli): add per-contract polling interval overrides",
    "trivial", "cli", 2,
    "Allow developers to set manual static intervals for individual contracts to bypass adaptive loops.",
    ["Add '--poll-interval <seconds>' option to watch command.", "Save overrides to the contracts database table.", "Fallback to adaptive logic if override is not set."],
    "Add overrides handling in daemon loop loop.ts.",
    ["'sorokeep watch <id> --poll-interval 300' saves override.", "Daemon runs checks on the exact custom interval."]
));
issues.push(createIssue(
    "feat(core): implement RPC rate limiting",
    "medium", "core", 2,
    "Build a rate limiter to throttle RPC requests, protecting your client from getting blocked by public Stellar nodes.",
    ["Implement queue-based rate limiter in src/rpc/client.ts.", "Set maximum limit to N requests per second (default 5).", "Queue requests exceeding the limit, executing them sequentially."],
    "Use async sleep helper delays.",
    ["RPC queries do not exceed the configured limit.", "All queued requests resolve successfully."]
));
issues.push(createIssue(
    "feat(core): implement footprint-based storage key discovery",
    "high", "core", 2,
    "Dynamically discover persistent storage keys by scanning transaction histories and parsing footprint changes on-chain.",
    ["Query Stellar RPC getEvents/getTransactions to find contract invocations.", "Parse transaction metadata to extract footprint read/write keys.", "Verify keys belong to watched contract and register them in contract_entries database table."],
    "Examine transaction metadata XDR formats using @stellar/stellar-sdk.",
    ["Discovers storage keys touched during contract interactions.", "Saves new keys to SQLite database."]
));
issues.push(createIssue(
    "feat(core): parse instance storage from contract instance entry",
    "medium", "core", 2,
    "Automatically parse and register storage keys embedded directly inside a contract's instance data.",
    ["Query RPC for the contract instance ledger entry.", "Decode instance XDR and extract the storage map array.", "Register all discovered keys in SQLite database under 'instance_scan' source."],
    "Refer to instance entry decoding schema in @stellar/stellar-sdk.",
    ["Discovers and registers keys stored inside contract instance map array."]
));

// --- Phase 3: State Introspection & Observability (Issues 46-65) ---
issues.push(createIssue(
    "feat(core): build SCVal-to-JSON type translator",
    "high", "core", 3,
    "Build a robust parser to translate raw Soroban XDR types (SCVal) into clean, human-readable JSON formats.",
    ["Map SCVal types (scvSymbol, scvMap, scvVec, scvAddress, scvI128, etc.) to JSON.", "Implement parser supporting deep nested data structures.", "Write unit tests for complex structures."],
    "Look at SCVal interface in @stellar/stellar-sdk. Handle bigints gracefully.",
    ["Translates SCVal structures successfully.", "Decodes nested maps and vectors correctly without losing precision."]
));
issues.push(createIssue(
    "feat(core): build ledger entry key decoder",
    "medium", "core", 3,
    "Decode base64 XDR ledger keys into human-readable symbols and addresses for better CLI UX.",
    ["Decode ledger_key_xdr strings.", "Extract symbol names, durability types, and target contract addresses.", "Write test suite verifying XDR decoder outputs."],
    "Combine SCVal translator with Stellar SDK XDR definitions.",
    ["Decodes instance and data storage key symbols successfully.", "Correctly formats durability properties."]
));
issues.push(createIssue(
    "feat(cli): add inspect command for decoded entry values",
    "medium", "cli", 3,
    "Expose an inspect command to query and view raw storage values inside contract keys.",
    ["Implement 'inspect' subcommand: `sorokeep inspect <contractId> --entry <keyXdr>`.", "Query entry from RPC, parse through SCVal decoder, and print JSON structure."],
    "Use standard commander configurations. Handle missing keys gracefully.",
    ["'sorokeep inspect' fetches and prints valid JSON.", "Prints error if target key is not active on-chain."]
));
issues.push(createIssue(
    "feat(cli): support custom schema files for state formatting",
    "medium", "cli", 3,
    "Allow developers to load custom mapping schemas to translate raw symbol keys into custom developer labels.",
    ["Add '--schema <path>' option to inspect command.", "Replace raw symbols with mapped dictionary labels when rendering JSON on console."],
    "Ensure schema syntax is validated on load.",
    ["Loads and parses JSON schema configurations.", "Correctly formats outputs using schema dictionary."]
));
issues.push(createIssue(
    "feat(core): decode Stellar Asset Contract (SAC) balances",
    "medium", "core", 3,
    "Provide a custom decoder to inspect token balances in standard Stellar Asset Contracts.",
    ["Build custom parser for SAC balance map layout.", "Add CLI shortcut: `sorokeep inspect --entry balance:<address>` to auto-locate balance slots."],
    "SAC contracts use standardized storage key formats for address balances.",
    ["Correctly decodes and prints address balance decimals.", "Fails gracefully on non-SAC contracts."]
));
issues.push(createIssue(
    "spec: draft get_monitored_keys() contract convention",
    "trivial", "docs", 3,
    "Define a standard contract introspection standard for developers to declare their monitored keys on-chain.",
    ["Write get_monitored_keys_spec.md proposal.", "Outline Rust contract view function returning vec of storage keys.", "Add example implementations."],
    "Review standard ERC/SEP metadata conventions.",
    ["Spec document is complete and outlines standard signature.", "Includes valid Rust Soroban contract code snippets."]
));
issues.push(createIssue(
    "feat(core): call introspection function during watch",
    "high", "core", 3,
    "Query the introspection method on registration to automatically discover and monitor developer-declared keys.",
    ["Check if target contract exposes 'get_monitored_keys' during watchContract execution.", "Invoke method, parse returned keys, and register them in DB.", "Fallback to standard instance/WASM tracking if method does not exist."],
    "Use StellarRpcClient to invoke view methods on-chain.",
    ["Introspects and watches declared keys on support contracts.", "Completes watch cleanly if method is absent."]
));
issues.push(createIssue(
    "feat(daemon): periodically re-scan introspection",
    "medium", "daemon", 3,
    "Monitor contracts for changes in their declared keys by running periodic introspection scans.",
    ["Schedule an introspection re-scan hook inside the daemon loop.", "Query get_monitored_keys() and add newly declared keys dynamically."],
    "Avoid duplicate key registrations by checking active DB entries first.",
    ["Discovers new keys added to contract after initial watch registration.", "Does not duplicate existing watched keys."]
));
issues.push(createIssue(
    "feat(cli): add --no-introspection flag to watch command",
    "trivial", "cli", 3,
    "Provide a flag to disable automatic contract introspection during watch registration.",
    ["Add '--no-introspection' option to watch command.", "Ensure watch skips get_monitored_keys view calls when flag is present."],
    "Look at src/commands/watch.ts options registration.",
    ["'sorokeep watch <id> --no-introspection' executes watch without sending contract view calls."]
));
issues.push(createIssue(
    "feat(core): cache introspection results in database",
    "trivial", "core", 3,
    "Cache get_monitored_keys results in SQLite to minimize RPC calls and load times.",
    ["Add 'last_introspected_at' column to contracts table.", "Query contract introspection only if cache is older than 24 hours."],
    "Read timestamps using standard SQLite date functions.",
    ["Subsequent daemon runs skip introspection queries if cache is valid.", "Force refresh works on manual commands."]
));
issues.push(createIssue(
    "feat(core): extract CPU and memory usage from transaction metadata",
    "high", "core", 3,
    "Extract transaction resource costs from RPC execution metadata.",
    ["Fetch transaction results from Stellar RPC.", "Decode transaction result metadata XDR.", "Extract cpuInstructions and memoryBytes parameters."],
    "Metadata XDR structure contains detailed resource usage under SorobanTransactionData.",
    ["Extracts and logs CPU instructions and memory consumption metrics successfully."]
));
issues.push(createIssue(
    "feat(db): add resource_usage_logs table",
    "trivial", "db", 3,
    "Create a SQLite table to store historical resource consumption data for analytics.",
    ["Define resource_usage_logs schema in schema.sql.", "Implement repository insert functions to save CPU, memory, and fee parameters per transaction."],
    "Keep indices on contract_id and recorded_at for fast query times.",
    ["Schema migration runs successfully.", "Log entry writing passes repository unit tests."]
));
issues.push(createIssue(
    "feat(cli): add resources command",
    "medium", "cli", 3,
    "Show historical resource consumption trends and usage metrics for a contract.",
    ["Implement 'resources' CLI command in src/commands/resources.ts.", "Query logs, calculate average/min/max CPU and memory usage, and print formatted metrics table."],
    "Use standard command table rendering formatting.",
    ["Command runs and displays structured resource usage averages.", "Filter flags (e.g. --period) work correctly."]
));
issues.push(createIssue(
    "feat(alerts): alert on resource consumption spikes",
    "medium", "alerts", 3,
    "Send warning notifications if a transaction's resource usage approaches on-chain execution limits.",
    ["Add --cpu-limit and --mem-limit option to alerts add.", "Compare transaction resource logs against limit thresholds.", "Dispatch 'resource_alert' events when limits are crossed."],
    "Standard Soroban limits are 100,000,000 instructions per transaction.",
    ["Resource warnings are correctly triggered and delivered on execution spikes."]
));
issues.push(createIssue(
    "feat(core): calculate sliding-window resource averages",
    "medium", "core", 3,
    "Implement rolling resource usage averages to support cost anomaly checks.",
    ["Build utility calculating moving average of CPU and memory usage over past 100 invocations.", "Expose method to compare current transaction usage against baseline averages."],
    "Perform rolling averages queries inside repositories.ts.",
    ["Returns correct average values.", "Anomalous executions are flagged when resource use spikes 3x above average."]
));
issues.push(createIssue(
    "feat(core): implement rent cost projection model",
    "high", "core", 3,
    "Build a forecasting engine to project contract rent costs over 30, 60, and 90 days.",
    ["Compute rent projections based on entry bytes size, network base fee, and target TTLs.", "Write unit tests verifying projection estimations under varying network fee rates."],
    "Rent is calculated by multiplying state bytes by base fee and remaining lease ledger counts.",
    ["Math calculations match actual Stellar Soroban rent formulas.", "Returns correct future projections."]
));
issues.push(createIssue(
    "feat(cli): add cost projections to costs command",
    "medium", "cli", 3,
    "Update the costs command to display forecasted rent cost metrics.",
    ["Update src/commands/costs.ts to print forecast details.", "Compare forecast results against monthly budgets, displaying alerts on budget overrun risks."],
    "Display warning flags in red if the projection breaches limits.",
    ["Costs command includes 'Forecasted Rent' section.", "Shows budget warnings when projected costs exceed settings."]
));
issues.push(createIssue(
    "feat(core): dynamic fee estimation from network load",
    "medium", "core", 3,
    "Integrate live network fee rates into cost projections by querying fee stats dynamically.",
    ["Query getFeeStats RPC endpoint.", "Incorporate current base and surge pricing metrics inside projection calculations."],
    "Look at getFeeStats implementation details.",
    ["Cost projections adjust dynamically based on live network base fees."]
));
issues.push(createIssue(
    "feat(db): aggregate daily cost snapshots",
    "trivial", "db", 3,
    "Store aggregated daily cost snapshots to optimize historical query performance.",
    ["Create cost_daily_snapshots database table.", "Implement daily aggregation script running at the end of cycles.", "Redirect cost logs queries to snapshots table."],
    "Reduce database size by aggregating thousands of small transaction logs.",
    ["Daily snapshots table updates correctly.", "Projections and cost queries run 5x faster."]
));
issues.push(createIssue(
    "feat(alerts): alert when projected cost exceeds budget",
    "trivial", "alerts", 3,
    "Trigger early-warning notifications if projected rent costs are set to breach monthly budgets.",
    ["Compare 30-day projected costs against monthly contract budgets.", "Fire a 'budget_warning' AlertEvent if projected spend exceeds limits by >20%."],
    "Ensure checks run at the end of cost snapshots consolidation.",
    ["Alerts are fired and delivered when cost projections exceed budget limits."]
));

// --- Phase 4: Ecosystem Integration (Issues 66-85) ---
issues.push(createIssue(
    "feat(core): implement MCP server with stdio transport",
    "high", "core", 4,
    "Build a Model Context Protocol (MCP) server inside the CLI tool to expose contract metadata to AI agents.",
    ["Implement MCP Server class using @modelcontextprotocol/sdk.", "Configure stdio transport stream.", "Expose basic server lifecycle configuration."],
    "Add @modelcontextprotocol/sdk as dependency in package.json.",
    ["MCP server starts and listens on stdio.", "Returns correct handshake parameters to client."]
));
issues.push(createIssue(
    "feat(mcp): register get_contract_status tool",
    "medium", "alerts", 4,
    "Expose an MCP tool for AI assistants to query contract TTL states and health metrics.",
    ["Register get_contract_status tool on the MCP server.", "Accept contractId as parameter.", "Query SQLite and return JSON status, entries, and TTL lifespans."],
    "Leverage status.ts data mapping logic.",
    ["AI tool call returns correct JSON representation of contract TTLs."]
));
issues.push(createIssue(
    "feat(mcp): register list_watched_contracts tool",
    "trivial", "alerts", 4,
    "Expose an MCP tool listing all watched contracts and their summary statuses.",
    ["Register list_watched_contracts tool.", "Return array of watched contracts (ID, name, network, health status)."],
    "Query contracts table in SQLite.",
    ["AI tool call returns list of monitored contracts successfully."]
));
issues.push(createIssue(
    "feat(mcp): register get_extension_costs tool",
    "medium", "alerts", 4,
    "Expose an MCP tool to fetch cost histories and rent projections.",
    ["Register get_extension_costs tool on the server.", "Accept contractId and period as inputs.", "Return JSON cost history summaries and future cost projections."],
    "Leverage costs.ts repository query logic.",
    ["AI tool call returns detailed cost structures and projections."]
));
issues.push(createIssue(
    "feat(mcp): add SSE transport support",
    "medium", "core", 4,
    "Support SSE (Server-Sent Events) transport in the MCP server to allow remote HTTP connections.",
    ["Implement SSE transport server in src/core/mcp.ts.", "Expose configurable HTTP port.", "Test remote MCP clients connection status."],
    "Use Express or Node HTTP module to serve SSE streams.",
    ["MCP server connects and communicates successfully via SSE HTTP streams."]
));
issues.push(createIssue(
    "feat(cli): implement check command for CI pipelines",
    "medium", "cli", 4,
    "Provide a check command designed to fail CI pipelines if watched contract TTLs are critical.",
    ["Implement 'check' command: `sorokeep check <contractId> --fail-under <ledgers>`.", "Exit with code 0 if all TTLs are safe, exit with code 1 if any TTL is below limit."],
    "Ensure command prints output cleanly without CLI spinners on stdout.",
    ["Command exits with code 1 when TTL is low.", "Exits with code 0 when all TTLs are safe."]
));
issues.push(createIssue(
    "feat(ci): create GitHub Action for TTL checks",
    "high", "devops", 4,
    "Publish a reusable GitHub Action to run Sorokeep TTL checks before deployments.",
    ["Write action.yml definition file.", "Build action runtime script installing sorokeep and executing check command.", "Expose parameters: contract-id, network, threshold."],
    "Reference the published NPM package or compile from source inside action container.",
    ["GitHub Action runs successfully on PR workflows.", "Fails the workflow run if contract TTL is below threshold."]
));
issues.push(createIssue(
    "feat(ci): create GitLab CI template",
    "trivial", "devops", 4,
    "Provide a GitLab CI configuration template for integrating TTL checks into GitLab pipelines.",
    ["Create template file .gitlab-ci.yml in templates/.", "Provide example jobs running sorokeep check in test stages."],
    "Document how variables and credentials should be mapped.",
    ["GitLab CI runs check stage successfully.", "Fails pipeline stage if TTL bounds are crossed."]
));
issues.push(createIssue(
    "feat(cli): add --force flag to bypass CI check failures",
    "trivial", "cli", 4,
    "Allow developers to bypass CI check blocks during hotfix deployments.",
    ["Add '--force' option to check command.", "Ensure command exits with code 0 even if TTL is low when --force is enabled, printing warning."],
    "Mute standard exit codes when override is active.",
    ["check command with --force exits with 0 on low TTL.", "Prints warning message to stdout."]
));
issues.push(createIssue(
    "docs: write CI/CD integration guide",
    "trivial", "docs", 4,
    "Document how to set up Sorokeep checks in popular CI/CD providers.",
    ["Create CICD.md guide in docs/.", "Include examples for GitHub Actions, GitLab CI, and Bitbucket Pipelines."],
    "Keep instructions clear and copy-pasteable.",
    ["CI/CD integration guide is complete and accurate."]
));
issues.push(createIssue(
    "feat(alerts): implement Discord webhook delivery",
    "medium", "alerts", 4,
    "Deliver rich status alerts to Discord channels using Discord Webhook API.",
    ["Create DiscordChannel class in src/alerts/discord.ts.", "Format AlertEvent into Discord Embed JSON format.", "POST payload to configured Discord webhook URL."],
    "Discord embeds use standard color-coded side bars and fields layouts.",
    ["Discord webhook POST returns success.", "Message displays details formatted with correct severity colors."]
));
issues.push(createIssue(
    "feat(alerts): implement Telegram Bot delivery",
    "medium", "alerts", 4,
    "Deliver alerts to Telegram groups or channels via Telegram Bot API.",
    ["Create TelegramChannel class in src/alerts/telegram.ts.", "Build markdown formatted message payload.", "Send payload via Telegram sendMessage API endpoint."],
    "Requires bot token and chat ID configurations.",
    ["Telegram notification is successfully delivered to chat."]
));
issues.push(createIssue(
    "feat(alerts): implement PagerDuty Events API v2 integration",
    "medium", "alerts", 4,
    "Integrate with PagerDuty to trigger incidents on critical TTL thresholds.",
    ["Create PagerDutyChannel class in src/alerts/pagerduty.ts.", "Trigger PagerDuty incident on threshold_crossed.", "Resolve PagerDuty incident on alert_resolved."],
    "Use PagerDuty Events v2 payload schema.",
    ["PagerDuty API creates alert incident successfully.", "Resolution event closes incident automatically."]
));
issues.push(createIssue(
    "feat(alerts): implement SMTP email delivery",
    "medium", "alerts", 4,
    "Send HTML alert emails to system operations teams via SMTP.",
    ["Create EmailChannel class in src/alerts/email.ts.", "Format HTML email message using templates.", "Send email using nodemailer client module."],
    "Configure SMTP host, port, user, and password in config.yaml.",
    ["Alert email is successfully delivered to recipient inbox."]
));
issues.push(createIssue(
    "feat(alerts): support custom message templates",
    "medium", "alerts", 4,
    "Allow customizing alert notification layouts using Handlebars templates.",
    ["Integrate handlebars package.", "Add template path option in configurations.", "Compile and render custom templates during alert builds."],
    "Provide default templates inside project resources.",
    ["Dispatched alerts use custom message formats when config is active."]
));
issues.push(createIssue(
    "feat(core): export core functions as npm package API",
    "high", "core", 4,
    "Export core monitoring, watching, and delivery logic to support programmatic imports by other Node.js apps.",
    ["Create entry point exports in package.json.", "Publish TypeScript type declarations.", "Ensure CLI commander dependencies are decoupled from library exports."],
    "Verify build exports files in package.json formats.",
    ["Third-party node project can successfully import watchContract and runMonitorCycle from sorokeep package."]
));
issues.push(createIssue(
    "feat(devops): create official Dockerfile",
    "medium", "devops", 4,
    "Package the CLI tool inside an optimized production Docker container.",
    ["Create multi-stage Dockerfile.", "Compile typescript source and exclude development dependencies.", "Run container under non-root user.", "Configure storage volume mount for SQLite database."],
    "Expose ports for dashboard API or MCP server.",
    ["Docker image builds successfully.", "Container runs CLI commands and daemon processes cleanly."]
));
issues.push(createIssue(
    "feat(devops): create docker-compose for full environment",
    "trivial", "devops", 4,
    "Provide compose templates to run the daemon alongside a local devnet sandbox.",
    ["Create docker-compose.yaml.", "Configure sorokeep daemon container and local Stellar Quickstart container.", "Map environment configurations."],
    "Verify volume paths map correctly across containers.",
    ["docker-compose up boots daemon and mock RPC environment successfully."]
));
issues.push(createIssue(
    "feat(devops): write systemd service template",
    "trivial", "devops", 4,
    "Provide systemd service descriptors for running the daemon as a system service on Linux.",
    ["Create sorokeep-daemon.service configuration template.", "Configure auto-restart on failures.", "Write setup instructions in docs."],
    "Ensure logging output maps to journald.",
    ["Service file loads cleanly.", "Daemon starts and stops successfully using systemctl."]
));
issues.push(createIssue(
    "feat(devops): write PM2 ecosystem config",
    "trivial", "devops", 4,
    "Provide a PM2 configuration profile to manage the node daemon process in production.",
    ["Create PM2 ecosystem.config.js.", "Configure log rotations, memory limits, and auto-restart policies."],
    "Set process instance count to 1 to prevent DB locking conflicts.",
    ["PM2 runs and monitors the daemon process successfully."]
));

// --- Phase 5: Production Hardening & Scale (Issues 86-100) ---
issues.push(createIssue(
    "feat(core): implement channel accounts pool",
    "high", "core", 5,
    "Build a pool of channel accounts to submit auto-extension transactions concurrently without sequence conflicts.",
    ["Implement ChannelAccountPool class in src/core/channels.ts.", "Support registering multiple channel keypairs in DB.", "Implement round-robin key allocation to process concurrent extensions."],
    "Channel accounts must be pre-funded on-chain with base XLM.",
    ["Daemon processes multiple extensions in parallel without sequence errors.", "Balances are monitored and reported."]
));
issues.push(createIssue(
    "feat(core): implement sequence number recovery",
    "medium", "core", 5,
    "Recover automatically from transaction sequence failures by refreshing sequence numbers from the RPC.",
    ["Detect bad_sequence errors on transaction submissions.", "Query RPC to fetch current on-chain account sequence.", "Increment sequence and retry transaction once."],
    "See transaction error mapping details in @stellar/stellar-sdk.",
    ["Recovers and succeeds on resubmission after sequence mismatch.", "Logs sequence correction warnings."]
));
issues.push(createIssue(
    "feat(core): support fee-bump transaction wrapping",
    "medium", "core", 5,
    "Support wrapping auto-extension transactions in fee-bump wrappers for fee sponsorship.",
    ["Implement FeeBumpTransaction wrapping in src/core/extension.ts.", "Configure fee-sponsor keypair in config.", "Submit transactions with sponsor signature paying for resources."],
    "Refer to FeeBumpTransaction construction in Stellar SDK.",
    ["Auto-extensions are paid for by the sponsor account.", "Sponsor transaction signatures are validated successfully."]
));
issues.push(createIssue(
    "feat(cli): add channel account management commands",
    "medium", "cli", 5,
    "Provide commands to add, list, and fund channel accounts.",
    ["Add 'channels' subcommands: add, list, fund.", "channels fund: send base XLM from master wallet to all channel accounts."],
    "Build transaction sequence using standard payment operations.",
    ["'sorokeep channels add' registers keys.", "'sorokeep channels fund' distributes XLM to pool successfully."]
));
issues.push(createIssue(
    "feat(db): implement lightweight schema migration engine",
    "high", "db", 5,
    "Build a schema migration manager to execute versioned updates to the SQLite database without losing user data.",
    ["Implement Migrator class in src/db/migrator.ts.", "Track applied versions in schema_migrations table.", "Execute migrations dynamically on database connection startup."],
    "Store migrations as numbered SQL files (001_initial.sql, etc.).",
    ["Runs all pending migrations sequentially.", "Rolls back transaction changes safely if a script fails."]
));
issues.push(createIssue(
    "feat(db): extract current schema into migration 001",
    "trivial", "db", 5,
    "Migrate the initial database setup script into the migrations engine.",
    ["Move current schema.sql tables into migrations/001_initial_schema.sql.", "Update database.ts to execute migrations on initialize."],
    "Remove old raw exec calls from database connection setup.",
    ["Clean database boots and builds all tables successfully from migration file."]
));
issues.push(createIssue(
    "feat(db): implement automatic database vacuum",
    "trivial", "db", 5,
    "Optimize SQLite database space periodically by running database vacuum cleanups.",
    ["Implement daily vacuum script inside daemon loop.", "Trigger SQL 'VACUUM' statement during daemon idle intervals."],
    "Avoid running vacuum during active monitoring loops to prevent database lockups.",
    ["Database file size shrinks successfully after cascade deletes.", "Does not lock active transactions."]
));
issues.push(createIssue(
    "feat(cli): add database maintenance commands",
    "trivial", "cli", 5,
    "Provide CLI commands to manage database migrations and run manual maintenance.",
    ["Implement subcommands: `sorokeep db migrate`, `sorokeep db status`, `sorokeep db vacuum`."],
    "Expose database migrator API to command handlers.",
    ["Command prints list of applied migrations.", "db vacuum executes successfully."]
));
issues.push(createIssue(
    "feat(core): implement state value diff detection",
    "high", "core", 5,
    "Compare and diff contract storage values between monitoring cycles to track state mutations.",
    ["Create state_snapshots database table.", "Save entry value hashes and raw XDR during cycles.", "Diff current value against last saved snapshot, generating detailed diff report."],
    "Optimize storage by saving value logs only when changes are detected.",
    ["Diff engine returns correct additions, deletions, and edits.", "Logs state diff history in database."]
));
issues.push(createIssue(
    "feat(db): add state_snapshots and state_changes tables",
    "trivial", "db", 5,
    "Create SQLite tables to persist contract state snapshots and value diffs.",
    ["Define state_snapshots and state_changes schemas in schema.sql.", "Add database write and query repository utilities in repositories.ts."],
    "Refer to Phase 5 diff requirements for fields layout.",
    ["Schema tables create successfully.", "Repository tests verify snapshot CRUD actions pass."]
));
issues.push(createIssue(
    "feat(alerts): alert on configured state changes",
    "medium", "alerts", 5,
    "Configure alerts to notify teams when watched storage values mutate on-chain.",
    ["Add custom filter triggers to alerts.", "Fire 'state_changed' AlertEvent when diff engine flags mutations on watched storage keys."],
    "Payload must contain old value and new value representation.",
    ["Fires alert notifications on watched storage value changes.", "Webhook and Slack receive detailed diff payload."]
));
issues.push(createIssue(
    "feat(cli): add history command to show state changes",
    "medium", "cli", 5,
    "Provide a CLI command to view the historical timeline of contract storage value mutations.",
    ["Implement 'history' CLI command in src/commands/history.ts.", "Query state_changes, format timestamps and XDR diffs, and print formatted timeline."],
    "Print XDR values using the SCVal translator.",
    ["'sorokeep history <contractId>' prints clean change history.", "Shows symbol, old value, and new value diffs."]
));
issues.push(createIssue(
    "test(e2e): setup complete end-to-end testing pipeline",
    "high", "tests", 5,
    "Build a full E2E testing framework to run automated tests against a running sandbox network.",
    ["Create E2E tests workspace in tests/e2e/.", "Bootstrap local network, deploy test contract, watch, let TTL expire, auto-extend, and verify recovery."],
    "Use Docker network containers or local quickstart instances.",
    ["E2E test suite executes fully with zero manual setups.", "Verifies all components cooperate successfully."]
));
issues.push(createIssue(
    "test(e2e): verify monitoring daemon execution cycles",
    "medium", "tests", 5,
    "Test daemon loop durability and recovery under simulated network dropouts.",
    ["Simulate RPC connection failures, database write locks, and sequence errors.", "Assert daemon recovers and continues execution cycles safely without crashing."],
    "Use mock network interception libraries.",
    ["Daemon runs consecutively under unstable network simulations.", "Successfully recovers and completes monitoring cycles."]
));
issues.push(createIssue(
    "docs: write contributor onboarding and architecture guides",
    "trivial", "docs", 5,
    "Provide complete documentation to help new contributors get started with the codebase.",
    ["Create CONTRIBUTING.md guidelines.", "Write Architecture Decision Records (ADRs) explaining SQLite, ESM, and design choices.", "Provide setup instructions for E2E sandboxes."],
    "Structure documents clearly with maps and code samples.",
    ["Onboarding docs are complete and hosted in the repository root.", "All references are fully validated."]
));

// Write issues to a json file
const dbPath = "./scripts/issues_db.json";
fs.writeFileSync(dbPath, JSON.stringify(issues, null, 2), "utf-8");
console.log(`Generated ${issues.length} issues in ${dbPath}`);
