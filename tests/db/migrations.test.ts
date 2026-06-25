import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "../../src/db/migrate";
import { getDatabaseForTesting } from "../../src/db/database";

// Tables that must exist after running migration 001 (mirrors the previous
// authoritative schema.sql so we can detect regressions on either side).
const EXPECTED_TABLES = [
    "contracts",
    "contract_entries",
    "extension_policies",
    "alert_configs",
    "alerts_fired",
    "extension_history",
];

function tableExists(db: Database.Database, name: string): boolean {
    const row = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name);
    return row !== undefined;
}

describe("runMigrations", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
    });

    it("is exported as a function from src/db/migrate", () => {
        expect(typeof runMigrations).toBe("function");
    });

    it("creates the schema_migrations bookkeeping table", () => {
        runMigrations(db);

        expect(tableExists(db, "schema_migrations")).toBe(true);
    });

    it("records migration 001 as applied on a clean database", () => {
        runMigrations(db);

        const rows = db
            .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
            .all() as { version: string }[];

        expect(rows.map((r) => r.version)).toContain("001");
    });

    it("creates every operational table from migration 001", () => {
        runMigrations(db);

        for (const table of EXPECTED_TABLES) {
            expect(tableExists(db, table)).toBe(true);
        }
    });

    it("is idempotent — calling twice does not duplicate rows or throw", () => {
        runMigrations(db);
        const firstCount = (
            db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }
        ).n;

        // Second call must be a no-op
        expect(() => runMigrations(db)).not.toThrow();

        const secondCount = (
            db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }
        ).n;
        expect(secondCount).toBe(firstCount);
    });

    it("returns the list of migrations applied during the call", () => {
        const applied = runMigrations(db);
        expect(Array.isArray(applied)).toBe(true);
        expect(applied).toContain("001");
    });

    it("returns an empty (or already-applied) list on a repeated call", () => {
        runMigrations(db);
        const applied = runMigrations(db);
        // Nothing was newly applied on a re-run.
        expect(applied).toEqual([]);
    });

    it("does not damage data when applied to a database with rows", () => {
        runMigrations(db);

        // Insert a sentinel row into contracts, then re-run migrations.
        db.prepare(
            "INSERT INTO contracts (id, name, network) VALUES (?, ?, ?)",
        ).run("CTEST", "sentinel", "testnet");

        runMigrations(db);

        const row = db
            .prepare("SELECT name FROM contracts WHERE id = ?")
            .get("CTEST") as { name: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.name).toBe("sentinel");
    });
});

describe("getDatabaseForTesting", () => {
    it("returns an in-memory database with every operational table ready", () => {
        const testDb = getDatabaseForTesting();

        for (const table of EXPECTED_TABLES) {
            expect(tableExists(testDb, table)).toBe(true);
        }
    });

    it("returns an in-memory database with the schema_migrations table ready", () => {
        const testDb = getDatabaseForTesting();
        expect(tableExists(testDb, "schema_migrations")).toBe(true);
    });
});
