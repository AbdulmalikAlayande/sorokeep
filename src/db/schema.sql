CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    name TEXT,
    network TEXT NOT NULL DEFAULT 'testnet',
    wasm_hash TEXT,
    tags TEXT,
    poll_interval_seconds INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_checked_ledger INTEGER,
    last_introspected_at DATETIME
);

CREATE TABLE IF NOT EXISTS contract_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    entry_key_xdr TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary')),
    label TEXT,
    live_until_ledger INTEGER,
    last_modified_ledger INTEGER,
    discovery_source TEXT NOT NULL DEFAULT 'deterministic' CHECK(discovery_source IN ('deterministic', 'manual', 'instance_scan', 'footprint', 'introspection')),
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_checked_at DATETIME,
    UNIQUE(contract_id, entry_key_xdr)
);

CREATE TABLE IF NOT EXISTS extension_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT 0,
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    keypair_public TEXT,
    keypair_source TEXT,
    -- Hard per-transaction fee ceiling in stroops (issue #420). NULL means
    -- no ceiling — the existing monthly budget check is the only guard.
    max_fee_stroops INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Number of daemon cycles ahead to project TTL crossing via linear-regression
    -- decay rate (issue #492). 0 = predictive scheduling disabled (reactive only).
    predictive_cycles INTEGER NOT NULL DEFAULT 0,
    UNIQUE(contract_id)
);

-- Periodic live_until_ledger readings per contract entry, powering the
-- decay-rate calculation behind predictive TTL extension scheduling (#492).
-- Only the most recent MAX_TTL_SAMPLES (10) rows per entry are kept; older
-- rows are pruned by the application layer on each insert.
CREATE TABLE IF NOT EXISTS ttl_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    sampled_at_ledger INTEGER NOT NULL,
    live_until_ledger INTEGER NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ttl_samples_entry_ledger
    ON ttl_samples(entry_id, sampled_at_ledger DESC);

-- channel_type is validated against the alert channel registry
-- (src/alerts/registry.ts) at the application layer, not a fixed SQL enum —
-- this is what lets a contributor add a new alert channel without a schema
-- migration. The CHECK below only guards against an empty string.
CREATE TABLE IF NOT EXISTS alert_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL CHECK(channel_type <> ''),
    channel_target TEXT NOT NULL,
    threshold_ledgers INTEGER NOT NULL,
    webhook_secret TEXT,
    -- Quiet-hours / maintenance-window support (issue #325).
    -- All three columns are nullable: NULL means no quiet window is configured.
    -- HH:MM 24-hour format.  quiet_hours_timezone must be a valid IANA tz name.
    quiet_hours_start    TEXT,
    quiet_hours_end      TEXT,
    quiet_hours_timezone TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alerts_fired (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_config_id INTEGER NOT NULL REFERENCES alert_configs(id) ON DELETE CASCADE,
    contract_entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    fired_at_ledger INTEGER NOT NULL,
    fired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ttl_at_fire INTEGER NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT 0,
    resolved_at TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    delivered_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_fired_undelivered
    ON alerts_fired(delivered, retry_count);

CREATE INDEX IF NOT EXISTS idx_alerts_fired_resolved_fired_at
    ON alerts_fired(resolved, fired_at DESC);

CREATE TABLE IF NOT EXISTS channel_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL UNIQUE,
    keypair_source TEXT,
    label TEXT,
    network TEXT NOT NULL DEFAULT 'testnet',
    funded BOOLEAN NOT NULL DEFAULT 0,
    balance_xlm REAL,
    balance_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS extension_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    contract_entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    old_ttl_ledgers INTEGER NOT NULL,
    new_ttl_ledgers INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    cost_xlm REAL,
    cpu_insns INTEGER,
    mem_bytes INTEGER,
    is_anomaly INTEGER NOT NULL DEFAULT 0,
    executed_at_ledger INTEGER NOT NULL,
    executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_extension_history_contract_executed
    ON extension_history(contract_id, executed_at);

CREATE TABLE IF NOT EXISTS cost_daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    total_extensions INTEGER NOT NULL DEFAULT 0,
    total_cost_xlm REAL NOT NULL DEFAULT 0,
    instance_extensions INTEGER NOT NULL DEFAULT 0,
    instance_cost_xlm REAL NOT NULL DEFAULT 0,
    wasm_extensions INTEGER NOT NULL DEFAULT 0,
    wasm_cost_xlm REAL NOT NULL DEFAULT 0,
    persistent_extensions INTEGER NOT NULL DEFAULT 0,
    persistent_cost_xlm REAL NOT NULL DEFAULT 0,
    temporary_extensions INTEGER NOT NULL DEFAULT 0,
    temporary_cost_xlm REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS state_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    snapshot_ledger INTEGER NOT NULL,
    value_hash TEXT NOT NULL,
    value_xdr TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_state_snapshots_entry_ledger
    ON state_snapshots(contract_entry_id, snapshot_ledger DESC);

CREATE TABLE IF NOT EXISTS state_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    old_snapshot_id INTEGER REFERENCES state_snapshots(id) ON DELETE SET NULL,
    new_snapshot_id INTEGER REFERENCES state_snapshots(id) ON DELETE SET NULL,
    diff_type TEXT NOT NULL CHECK(diff_type IN ('created', 'updated', 'deleted')),
    diff_json TEXT NOT NULL,
    detected_at_ledger INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_state_changes_entry_detected_ledger
    ON state_changes(contract_entry_id, detected_at_ledger DESC);

CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    billing_cycle TEXT NOT NULL,
    limit_xlm REAL NOT NULL,
    spent_xlm REAL NOT NULL DEFAULT 0,
    UNIQUE(contract_id, billing_cycle)
);

-- See the comment above alert_configs — same reasoning applies here.
CREATE TABLE IF NOT EXISTS resource_alert_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL CHECK(channel_type <> ''),
    channel_target TEXT NOT NULL,
    cpu_limit INTEGER NOT NULL,
    mem_limit INTEGER NOT NULL,
    webhook_secret TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id, channel_type, channel_target)
);

CREATE TABLE IF NOT EXISTS resource_alerts_fired (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_alert_config_id INTEGER NOT NULL REFERENCES resource_alert_configs(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('cpu', 'memory')),
    usage INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    usage_percent INTEGER NOT NULL,
    fired_at_ledger INTEGER,
    fired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered INTEGER NOT NULL DEFAULT 0,
    delivered_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    resolved BOOLEAN NOT NULL DEFAULT 0,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS contract_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    monthly_limit_xlm REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id)
);



CREATE TABLE IF NOT EXISTS contract_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- Group-level default poll interval in seconds, consulted by
    -- resolvePollIntervalMs as a fallback tier between the per-contract
    -- override and the global --interval flag (issue #400).
    poll_interval_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contract_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES contract_groups(id) ON DELETE CASCADE,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    UNIQUE(group_id, contract_id)
);

CREATE TABLE IF NOT EXISTS resource_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    cpu_insns INTEGER NOT NULL,
    mem_bytes INTEGER NOT NULL,
    fee_instructions INTEGER,
    fee_read_ledger_entries INTEGER,
    fee_write_ledger_entries INTEGER,
    fee_read_bytes INTEGER,
    fee_write_bytes INTEGER,
    fee_transaction_size INTEGER,
    fee_historical_ledger INTEGER,
    fee_rent_ledger INTEGER,
    fee_refundable INTEGER,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_resource_usage_logs_contract_id
    ON resource_usage_logs(contract_id);
CREATE INDEX IF NOT EXISTS idx_resource_usage_logs_recorded_at
    ON resource_usage_logs(recorded_at DESC);


-- digest_configs: one row per "daily/periodic fleet health digest" delivery endpoint.
-- Deliberately separate from alert_configs because a digest has no threshold_ledgers,
-- no alert_config_id FK, and carries an interval_ms instead — semantically it is a
-- different concept from per-entry threshold alerts (issue #399).
CREATE TABLE IF NOT EXISTS digest_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network TEXT NOT NULL DEFAULT 'testnet',
    -- channel_type is validated at the application layer against the alert channel
    -- registry (same approach as alert_configs / resource_alert_configs).
    channel_type TEXT NOT NULL CHECK(channel_type <> ''),
    channel_target TEXT NOT NULL,
    -- How often (in milliseconds) the digest should be delivered.
    interval_ms INTEGER NOT NULL DEFAULT 86400000,
    webhook_secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fleet query performance indexes (matching migration 007, issue #406)
CREATE INDEX IF NOT EXISTS idx_contracts_network_active
    ON contracts(network, active);

CREATE INDEX IF NOT EXISTS idx_extension_history_executed_at
    ON extension_history(executed_at);

-- shared_budget_pools: an alternative to per-contract contract_budgets where
-- several contracts draw from one combined monthly cap. A contract assigned
-- to a pool (via shared_budget_pool_contracts) is enforced against the pool
-- instead of its individual budget — see runAutoExtensions in
-- core/extension.ts (issue #407).
CREATE TABLE IF NOT EXISTS shared_budget_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    monthly_limit_xlm REAL NOT NULL CHECK(monthly_limit_xlm >= 0),
    billing_cycle TEXT NOT NULL,
    spent_xlm REAL NOT NULL DEFAULT 0 CHECK(spent_xlm >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A contract may belong to at most one pool (contract_id is UNIQUE); pool
-- membership takes precedence over the contract's individual budget.
CREATE TABLE IF NOT EXISTS shared_budget_pool_contracts (
    pool_id INTEGER NOT NULL REFERENCES shared_budget_pools(id) ON DELETE CASCADE,
    contract_id TEXT NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(pool_id, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_budget_pool_contracts_pool_id
    ON shared_budget_pool_contracts(pool_id);

-- Per-entry-type TTL policy overrides, falling back to extension_policies
-- (contract-level default) when no type-specific override exists (#491).
CREATE TABLE IF NOT EXISTS entry_type_policies (
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary')),
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contract_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_entry_type_policies_contract_id
    ON entry_type_policies(contract_id);

-- Append-only version history of extension_policies, populated by every
-- upsertExtensionPolicy() call. Powers 'sorokeep guard rollback' (#506).
CREATE TABLE IF NOT EXISTS guard_policy_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL,
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    keypair_public TEXT,
    keypair_source TEXT,
    predictive_cycles INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guard_policy_history_contract_id
    ON guard_policy_history(contract_id, id DESC);
