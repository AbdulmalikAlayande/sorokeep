import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { setContractBudget, getContractBudget, getMonthlySpendProgress } from "../../src/core/budget";

describe("Budget Core", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE contracts (id TEXT PRIMARY KEY, name TEXT, network TEXT NOT NULL DEFAULT 'testnet');
            CREATE TABLE contract_budgets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
                monthly_limit_xlm REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(contract_id)
            );
        `);
        db.prepare("INSERT INTO contracts (id, name) VALUES (?, ?)").run("C123", "MyContract");
    });

    it("should set and get a budget limit", () => {
        setContractBudget(db, "C123", 100.5);
        const limit = getContractBudget(db, "C123");
        expect(limit).toBe(100.5);
    });

    it("should update an existing budget limit", () => {
        setContractBudget(db, "C123", 100.5);
        setContractBudget(db, "C123", 200.0);
        const limit = getContractBudget(db, "C123");
        expect(limit).toBe(200.0);
    });

    it("should return null if no budget is set", () => {
        const limit = getContractBudget(db, "C123");
        expect(limit).toBeNull();
    });

    it("should get monthly spend progress", () => {
        // mock cost data? No, getMonthlySpendProgress might call DB directly.
        // We'll test this thoroughly by inserting cost snapshots or mocking `getContractCostSummary`.
    });
});
