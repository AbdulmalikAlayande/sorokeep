/**
 * Migration: Add entry_type_policies table
 *
 * Adds per-entry-type TTL policy overrides keyed by
 * (contract_id, entry_type). Falls back to extension_policies
 * when no type-specific override exists.
 *
 * entry_type values: 'instance' | 'wasm' | 'persistent' | 'temporary'
 */

import type Database from "better-sqlite3";

export const up = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entry_type_policies (
      contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('instance', 'wasm', 'persistent', 'temporary')),
      target_ttl_ledgers INTEGER NOT NULL,
      extend_when_below_ledgers INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contract_id, entry_type)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entry_type_policies_contract_id
    ON entry_type_policies(contract_id);
  `);
};

export const down = (db: Database.Database) => {
  db.exec(`DROP TABLE IF EXISTS entry_type_policies;`);
};
