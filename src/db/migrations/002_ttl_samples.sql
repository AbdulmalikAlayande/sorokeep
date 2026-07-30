-- Migration 002: add ttl_samples table (issue #492)
--
-- ttl_samples stores periodic live_until_ledger readings per contract entry,
-- enabling decay-rate calculation for predictive TTL extension scheduling.
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
