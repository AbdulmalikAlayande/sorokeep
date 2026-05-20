import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
const SENTINEL_DIR = path.join(os.homedir(), '.soroban-sentinel');

const DB_PATH = path.join(SENTINEL_DIR, 'sentinel.db');

function ensureSentinelDirExists(dir: string) {
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
    ensureSentinelDirExists(path.dirname(dbPath));

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return db;
}

export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}

export function getDatabaseForTesting(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return db;
}