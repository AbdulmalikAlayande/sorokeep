import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Migrator } from "../../src/db/migrator";

describe("Schema Migrator", () => {
    let db: Database.Database;
    let tempDir: string;

    beforeEach(() => {
        // Create an in-memory SQLite database for testing
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");

        // Create a unique temporary migrations directory inside tests/db
        const testsDbDir = path.resolve("tests/db");
        if (!fs.existsSync(testsDbDir)) {
            fs.mkdirSync(testsDbDir, { recursive: true });
        }
        tempDir = fs.mkdtempSync(path.join(testsDbDir, "temp_migrations_"));
    });

    afterEach(() => {
        // Clean up temporary files and directory
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tempDir, file));
            }
            fs.rmdirSync(tempDir);
        }
        db.close();
    });

    it("runs all pending migrations sequentially and records them", () => {
        // Write sequential migrations
        fs.writeFileSync(
            path.join(tempDir, "001_create_users.sql"),
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);"
        );
        fs.writeFileSync(
            path.join(tempDir, "002_add_email.sql"),
            "ALTER TABLE users ADD COLUMN email TEXT;"
        );

        const migrator = new Migrator(db, tempDir);
        migrator.run();

        // Verify tables and columns exist
        const tableInfo = db.prepare("PRAGMA table_info(users);").all() as { name: string }[];
        const columnNames = tableInfo.map((col) => col.name);
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("name");
        expect(columnNames).toContain("email");

        // Verify applied versions are tracked in schema_migrations table
        const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC;").all() as { version: number }[];
        expect(applied).toEqual([{ version: 1 }, { version: 2 }]);
    });

    it("rolls back transaction changes safely if a script fails", () => {
        // Write an initial migration that succeeds
        fs.writeFileSync(
            path.join(tempDir, "001_init.sql"),
            "CREATE TABLE initial_table (id INTEGER PRIMARY KEY);"
        );

        // Write a migration that fails in the middle of execution
        fs.writeFileSync(
            path.join(tempDir, "002_fail.sql"),
            `
            CREATE TABLE test_rollback (id INTEGER PRIMARY KEY);
            INSERT INTO non_existent_table (id) VALUES (1); -- Force syntax/runtime error
            `
        );

        const migrator = new Migrator(db, tempDir);

        // Running migrations should throw an error
        expect(() => migrator.run()).toThrow();

        // Verify 001_init changes are committed
        const tableInfoInitial = db.prepare("PRAGMA table_info(initial_table);").all();
        expect(tableInfoInitial.length).toBeGreaterThan(0);

        // Verify 002_fail changes are rolled back completely
        const tableInfoRollback = db.prepare("PRAGMA table_info(test_rollback);").all();
        expect(tableInfoRollback.length).toBe(0);

        // Verify schema_migrations contains 1, but not 2
        const applied = db.prepare("SELECT version FROM schema_migrations;").all() as { version: number }[];
        expect(applied).toEqual([{ version: 1 }]);
    });

    it("skips already applied migrations and only runs new ones", () => {
        // Run first migration
        fs.writeFileSync(
            path.join(tempDir, "001_init.sql"),
            "CREATE TABLE main_table (id INTEGER PRIMARY KEY);"
        );

        const migrator = new Migrator(db, tempDir);
        migrator.run();

        // Verify main_table is created
        const tableInfo = db.prepare("PRAGMA table_info(main_table);").all();
        expect(tableInfo.length).toBeGreaterThan(0);

        // Now add a second migration and alter the first to fail if run again
        fs.writeFileSync(
            path.join(tempDir, "001_init.sql"),
            "CREATE TABLE main_table (id INTEGER PRIMARY KEY); -- This would fail if run again"
        );
        fs.writeFileSync(
            path.join(tempDir, "002_next.sql"),
            "CREATE TABLE next_table (id INTEGER PRIMARY KEY);"
        );

        // Run migrations again - should not throw and should apply 002
        expect(() => migrator.run()).not.toThrow();

        const nextTableInfo = db.prepare("PRAGMA table_info(next_table);").all();
        expect(nextTableInfo.length).toBeGreaterThan(0);

        const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC;").all() as { version: number }[];
        expect(applied).toEqual([{ version: 1 }, { version: 2 }]);
    });
});
