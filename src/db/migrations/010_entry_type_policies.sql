-- Migration 010: add entry_type_policies table (issue #491)
--
-- Adds per-entry-type TTL policy overrides keyed by (contract_id, entry_type).
-- Allows fine-grained control over extension parameters for instance, wasm,
-- persistent, and temporary entry types. Falls back to extension_policies
-- (contract-level default) when no type-specific override exists.

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
