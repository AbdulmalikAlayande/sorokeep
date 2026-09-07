import Database from "better-sqlite3";

/**
 * Build an in-memory SQLite database shaped like sorokeep's (only the two
 * tables and columns the extension actually reads). Returns the open DB.
 */
export function createFixtureDb(customPath?: string): Database.Database {
    const db = new Database(customPath ?? ":memory:");
    db.exec(`
        CREATE TABLE contracts (
            id TEXT PRIMARY KEY,
            name TEXT,
            network TEXT NOT NULL DEFAULT 'testnet',
            active INTEGER NOT NULL DEFAULT 1,
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_checked_ledger INTEGER
        );
        CREATE TABLE contract_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
            entry_key_xdr TEXT NOT NULL,
            entry_type TEXT NOT NULL,
            label TEXT,
            live_until_ledger INTEGER,
            last_modified_ledger INTEGER,
            discovery_source TEXT NOT NULL DEFAULT 'deterministic',
            first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_checked_at DATETIME,
            UNIQUE(contract_id, entry_key_xdr)
        );
    `);
    return db;
}

export const TRACKED_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const UNTRACKED_CONTRACT_ID = "CC7MAY3Y7WPF2PYTJT22PUPQLYLMLLHZSVCEQYS6G7P2QPQDGDCOBBCR";