-- Migration 012: add guard_policy_history table (issue #506)
--
-- Every upsertExtensionPolicy() call appends a snapshot of the saved policy
-- here, giving 'sorokeep guard rollback' a version history to restore from.
-- Rows are never updated or deleted by normal operation — rollback restores
-- a prior version by re-applying it through upsertExtensionPolicy, which
-- appends a new row rather than rewriting history.

CREATE TABLE IF NOT EXISTS guard_policy_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL,
    target_ttl_ledgers INTEGER NOT NULL,
    extend_when_below_ledgers INTEGER NOT NULL,
    keypair_public TEXT,
    keypair_source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guard_policy_history_contract_id
    ON guard_policy_history(contract_id, id DESC);
