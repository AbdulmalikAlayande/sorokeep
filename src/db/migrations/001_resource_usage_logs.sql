-- Migration 001: add resource_usage_logs table (issue #164)
--
-- Stores per-transaction CPU, memory, and fee-parameter snapshots so that
-- operators can track resource consumption over time without relying on
-- extension_history (which is specific to TTL-extension transactions).

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
