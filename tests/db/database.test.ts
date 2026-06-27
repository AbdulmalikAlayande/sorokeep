import { describe, it, expect, afterEach, vi } from "vitest";
import { getDatabase, closeDatabase, vacuumDatabase, getDatabaseForTesting } from "../../src/db/database";
import fs from "fs";
import path from "path";

describe("Database core functions", () => {
    afterEach(() => {
        closeDatabase();
        vi.restoreAllMocks();
    });

    describe("getDatabase", () => {
        it("creates and returns a singleton database", () => {
            const db1 = getDatabase();
            const db2 = getDatabase();
            expect(db1).toBe(db2);
            expect(db1).toBeDefined();
        });

        it("allows custom path", () => {
            const customPath = path.join(process.cwd(), "test-db-custom.sqlite");
            if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
            
            closeDatabase();
            const db = getDatabase(customPath);
            expect(db).toBeDefined();
            expect(fs.existsSync(customPath)).toBe(true);
            
            closeDatabase();
            if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
        });
    });

    describe("closeDatabase", () => {
        it("closes an active database", () => {
            const db = getDatabase();
            expect(db.open).toBe(true);
            closeDatabase();
            expect(db.open).toBe(false);
        });
        
        it("does nothing if db is already closed or null", () => {
            closeDatabase();
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    describe("vacuumDatabase", () => {
        it("runs VACUUM command", () => {
            const db = getDatabaseForTesting();
            const result = vacuumDatabase(db);
            expect(result).toBe(true);
            db.close();
        });

        it("returns false if db is in a transaction", () => {
            const db = getDatabaseForTesting();
            db.exec("BEGIN TRANSACTION");
            const result = vacuumDatabase(db);
            expect(result).toBe(false);
            db.exec("COMMIT");
            db.close();
        });

        it("returns false if database is locked/busy", () => {
            const db = getDatabaseForTesting();
            const originalExec = db.exec.bind(db);
            db.exec = vi.fn().mockImplementation((sql: string) => {
                if (sql === "VACUUM") {
                    throw new Error("database is locked");
                }
                return originalExec(sql);
            });
            const result = vacuumDatabase(db);
            expect(result).toBe(false);
            db.close();
        });

        it("throws if an unknown error occurs during VACUUM", () => {
            const db = getDatabaseForTesting();
            const originalExec = db.exec.bind(db);
            db.exec = vi.fn().mockImplementation((sql: string) => {
                if (sql === "VACUUM") {
                    throw new Error("Unknown error");
                }
                return originalExec(sql);
            });
            expect(() => vacuumDatabase(db)).toThrow("Unknown error");
            db.close();
        });
    });
});
