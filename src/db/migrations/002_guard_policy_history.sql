-- Migration 002: add guard_policy_history table (issue: guard policy change tracking)
--
-- Records a snapshot every time extension_policies is inserted or updated,
-- capturing both the prior (old_*) and new (new_*) values so operators can
-- audit "why did auto-extension behaviour change last week."
--
-- old_* columns are NULL for the very first insert on a contract (no prior row).

CREATE TABLE IF NOT EXISTS guard_policy_history (
    id                              INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id                     TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    -- values that were in place *before* this change (NULL on first insert)
    old_enabled                     INTEGER,
    old_target_ttl_ledgers          INTEGER,
    old_extend_when_below_ledgers   INTEGER,
    old_keypair_public              TEXT,
    old_keypair_source              TEXT,
    -- values that are now in place *after* this change
    new_enabled                     INTEGER NOT NULL,
    new_target_ttl_ledgers          INTEGER NOT NULL,
    new_extend_when_below_ledgers   INTEGER NOT NULL,
    new_keypair_public              TEXT,
    new_keypair_source              TEXT,
    changed_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_guard_policy_history_contract_changed
    ON guard_policy_history(contract_id, changed_at ASC);
