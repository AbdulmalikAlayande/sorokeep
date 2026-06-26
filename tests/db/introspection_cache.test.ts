/**
 * TDD tests for issue #162 — cache get_monitored_keys introspection results
 * in SQLite to minimize RPC calls.
 *
 * Covers:
 *  - Schema: last_introspected_at column present in contracts table
 *  - Live-migration path for existing DBs
 *  - updateLastIntrospectedAt repository function
 *  - isIntrospectionCacheValid repository function
 *    · NULL / missing  → false
 *    · valid (< 24 h)  → true
 *    · boundary (= 24h) → false  (expired, exclusive)
 *    · expired (> 24 h) → false
 *    · custom maxAgeMs
 */

import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    getContract,
    updateLastIntrospectedAt,
    isIntrospectionCacheValid,
} from "../../src/db/repositories";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

function seedContract(db: Database.Database, id = CONTRACT_ID): void {
    insertContract(db, { id, network: "testnet" });
}

// ─── Schema presence ─────────────────────────────────────────────────────────

describe("last_introspected_at column — schema", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("schema includes last_introspected_at column in contracts table", () => {
        const columns = db
            .prepare("PRAGMA table_info(contracts)")
            .all() as { name: string }[];
        expect(columns.map((c) => c.name)).toContain("last_introspected_at");
    });

    it("new contracts have last_introspected_at = NULL by default", () => {
        seedContract(db);
        const contract = getContract(db, CONTRACT_ID);
        expect(contract).toBeDefined();
        expect(contract!.last_introspected_at).toBeNull();
    });
});

// ─── Live-migration path ──────────────────────────────────────────────────────

describe("last_introspected_at column — live migration for existing DBs", () => {
    it("ALTER TABLE adds the column to a pre-existing DB that did not have it", () => {
        // Create a bare DB with the old schema (no last_introspected_at)
        const oldDb = new BetterSqlite3(":memory:");
        oldDb.pragma("foreign_keys = ON");
        oldDb.exec(`
            CREATE TABLE contracts (
                id TEXT PRIMARY KEY,
                name TEXT,
                network TEXT NOT NULL DEFAULT 'testnet',
                wasm_hash TEXT,
                tags TEXT,
                registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_checked_ledger INTEGER
            )
        `);

        const colsBefore = oldDb
            .prepare("PRAGMA table_info(contracts)")
            .all() as { name: string }[];
        expect(colsBefore.map((c) => c.name)).not.toContain("last_introspected_at");

        // Apply the same live-migration logic used in database.ts
        try {
            oldDb.exec("ALTER TABLE contracts ADD COLUMN last_introspected_at DATETIME");
        } catch {
            /* column already exists — no-op */
        }

        const colsAfter = oldDb
            .prepare("PRAGMA table_info(contracts)")
            .all() as { name: string }[];
        expect(colsAfter.map((c) => c.name)).toContain("last_introspected_at");

        oldDb.close();
    });

    it("live migration is idempotent — applying it twice does not throw", () => {
        const db2 = new BetterSqlite3(":memory:");
        db2.exec(`
            CREATE TABLE contracts (
                id TEXT PRIMARY KEY,
                network TEXT NOT NULL DEFAULT 'testnet'
            )
        `);

        const applyMigration = () => {
            try {
                db2.exec("ALTER TABLE contracts ADD COLUMN last_introspected_at DATETIME");
            } catch { /* already exists */ }
        };

        expect(() => {
            applyMigration();
            applyMigration(); // second call must not throw
        }).not.toThrow();

        db2.close();
    });
});

// ─── updateLastIntrospectedAt ─────────────────────────────────────────────────

describe("updateLastIntrospectedAt", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        seedContract(db);
    });

    it("sets last_introspected_at to the provided ISO timestamp", () => {
        const ts = "2026-06-26T10:00:00.000Z";
        updateLastIntrospectedAt(db, CONTRACT_ID, ts);
        expect(getContract(db, CONTRACT_ID)!.last_introspected_at).toBe(ts);
    });

    it("overwrites last_introspected_at when called a second time", () => {
        updateLastIntrospectedAt(db, CONTRACT_ID, "2026-06-25T10:00:00.000Z");
        const later = "2026-06-26T12:00:00.000Z";
        updateLastIntrospectedAt(db, CONTRACT_ID, later);
        expect(getContract(db, CONTRACT_ID)!.last_introspected_at).toBe(later);
    });

    it("is a no-op (does not throw) for a non-existent contract ID", () => {
        expect(() =>
            updateLastIntrospectedAt(db, "NON_EXISTENT_ID", new Date().toISOString()),
        ).not.toThrow();
    });
});

// ─── isIntrospectionCacheValid ────────────────────────────────────────────────

describe("isIntrospectionCacheValid", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        seedContract(db);
    });

    // ── NULL / missing ────────────────────────────────────────────────────────

    it("returns false when last_introspected_at is NULL (never introspected)", () => {
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(false);
    });

    it("returns false for a contract ID that does not exist in the DB", () => {
        expect(isIntrospectionCacheValid(db, "TOTALLY_UNKNOWN_CONTRACT")).toBe(false);
    });

    // ── Valid cache (< 24 h) ──────────────────────────────────────────────────

    it("returns true when last_introspected_at is 1 second ago", () => {
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(true);
    });

    it("returns true when last_introspected_at is 1 hour ago", () => {
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 60 * 60 * 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(true);
    });

    it("returns true when last_introspected_at is 23 h 59 min ago (just within window)", () => {
        const almostExpired = new Date(Date.now() - (23 * 60 + 59) * 60 * 1_000).toISOString();
        updateLastIntrospectedAt(db, CONTRACT_ID, almostExpired);
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(true);
    });

    // ── Exactly at the 24 h boundary ─────────────────────────────────────────

    it("returns false when last_introspected_at is exactly 24 hours ago (boundary — expired)", () => {
        const exactly24h = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
        updateLastIntrospectedAt(db, CONTRACT_ID, exactly24h);
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(false);
    });

    // ── Expired cache (> 24 h) ────────────────────────────────────────────────

    it("returns false when last_introspected_at is 25 hours ago (just expired)", () => {
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(false);
    });

    it("returns false when last_introspected_at is 7 days ago", () => {
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID)).toBe(false);
    });

    // ── Custom maxAgeMs ───────────────────────────────────────────────────────

    it("respects a custom maxAgeMs — valid when within the window", () => {
        // 30 min ago, TTL = 1 h → still valid
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 30 * 60 * 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID, 60 * 60 * 1_000)).toBe(true);
    });

    it("respects a custom maxAgeMs — expired when outside the window", () => {
        // 2 h ago, TTL = 1 h → expired
        updateLastIntrospectedAt(db, CONTRACT_ID, new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString());
        expect(isIntrospectionCacheValid(db, CONTRACT_ID, 60 * 60 * 1_000)).toBe(false);
    });
});
