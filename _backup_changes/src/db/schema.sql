CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    name TEXT,
    network TEXT NOT NULL DEFAULT 'testnet',
    wasm_hash TEXT,
    tags TEXT,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_checked_ledger INTEGER
);

CREATE TABLE IF NOT EXISTS contract_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    entry_key_xdr TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary')),
    label TEXT,
    live_until_ledger INTEGER,
    last_modified_ledger INTEGER,
    discovery_source TEXT NOT NULL DEFAULT 'deterministic' CHECK(discovery_source IN ('deterministic', 'manual', 'instance_scan', 'footprint')),
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id)
);

CREATE TABLE IF NOT EXISTS alert_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL CHECK(channel_type IN ('email', 'slack', 'webhook')),
    channel_target TEXT NOT NULL,
    threshold_ledgers INTEGER NOT NULL,
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
    delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS extension_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    contract_entry_id INTEGER NOT NULL REFERENCES contract_entries(id) ON DELETE CASCADE,
    old_ttl_ledgers INTEGER NOT NULL,
    new_ttl_ledgers INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    cost_xlm REAL,
    executed_at_ledger INTEGER NOT NULL,
    executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
