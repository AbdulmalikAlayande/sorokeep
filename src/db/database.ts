import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
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

    // ── Live migrations ───────────────────────────────────────────────────────
    // ALTER TABLE is idempotent-safe here: we catch the "duplicate column" error
    // that SQLite throws when the column already exists. This handles existing
    // sorokeep.db files created before these columns were added to schema.sql.
    const migrations = [
        `ALTER TABLE alerts_fired ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE alerts_fired ADD COLUMN delivered_at TEXT`,
        `ALTER TABLE alerts_fired ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE alert_configs ADD COLUMN webhook_secret TEXT`,
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* column already exists — no-op */ }
    }

    return db;
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
    return db;
}