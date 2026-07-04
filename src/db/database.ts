import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Migrator } from "./migrator.js";
const SOROKEEP_DIR = path.join(os.homedir(), '.sorokeep');

const DB_PATH = path.join(SOROKEEP_DIR, 'sorokeep.db');

function ensureDataDirExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_FILE_PATH = path.join(__dirname, 'schema.sql');
const SCHEMA = fs.readFileSync(SCHEMA_FILE_PATH, 'utf-8')
    .replace(/--.*\n/g, '') // Removes SQL comments
    .replace(/\s+/g, ' ') // Collapse whitespaces
    .trim();

let db: Database.Database | null = null;

export function getDatabase(customPath?: string): Database.Database {
    if (db) return db;

    const dbPath = customPath ?? DB_PATH;
    ensureDataDirExists(path.dirname(dbPath));

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    // Run schema migrations
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrator = new Migrator(db, migrationsDir);
    migrator.run();

    // ── Live migrations ───────────────────────────────────────────────────────
    // ALTER TABLE is idempotent-safe here: we catch the "duplicate column" error
    // that SQLite throws when the column already exists. This handles existing
    // sorokeep.db files created before these columns were added to schema.sql.
    const migrations = [
        `ALTER TABLE alerts_fired ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE alerts_fired ADD COLUMN delivered_at TEXT`,
        `ALTER TABLE alerts_fired ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE alert_configs ADD COLUMN webhook_secret TEXT`,
        `ALTER TABLE contracts ADD COLUMN poll_interval_seconds INTEGER`,
        `CREATE TABLE IF NOT EXISTS channel_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            public_key TEXT NOT NULL UNIQUE,
            keypair_source TEXT,
            label TEXT,
            network TEXT NOT NULL DEFAULT 'testnet',
            funded BOOLEAN NOT NULL DEFAULT 0,
            balance_xlm REAL,
            balance_checked_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `ALTER TABLE contracts ADD COLUMN last_introspected_at DATETIME`,
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* column already exists — no-op */ }
    }

    migrateAlertConfigsChannelTypeCheck(db);

    return db;
}

function migrateAlertConfigsChannelTypeCheck(db: Database.Database): void {
    const row = db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'alert_configs'
    `).get() as { sql?: string } | undefined;

    if (!row?.sql) {
        return;
    }

    const hasLegacyCheck = /CHECK\s*\(\s*channel_type\s+IN\s*\(\s*'slack'\s*,\s*'webhook'\s*\)\s*\)/i.test(row.sql);
    if (!hasLegacyCheck) {
        return;
    }

    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN TRANSACTION;");
    db.exec(`
        CREATE TABLE alert_configs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
            channel_type TEXT NOT NULL CHECK(channel_type IN ('slack', 'webhook', 'pagerduty')),
            channel_target TEXT NOT NULL,
            threshold_ledgers INTEGER NOT NULL,
            webhook_secret TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.exec(`
        INSERT INTO alert_configs_new (id, contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret, created_at)
        SELECT id, contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret, created_at
        FROM alert_configs
    `);
    db.exec(`DROP TABLE alert_configs;`);
    db.exec(`ALTER TABLE alert_configs_new RENAME TO alert_configs;`);
    db.exec("COMMIT;");
    db.exec("PRAGMA foreign_keys = ON;");
}

export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}

export function vacuumDatabase(db: Database.Database): boolean {
    if (db.inTransaction) {
        return false;
    }

    try {
        db.exec("VACUUM");
        return true;
    } catch (err: unknown) {
        if (err instanceof Error && /(busy|locked)/i.test(err.message)) {
            return false;
        }
        throw err;
    }
}

export function getDatabaseForTesting(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    // Run schema migrations
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrator = new Migrator(db, migrationsDir);
    migrator.run();

    return db;
}
