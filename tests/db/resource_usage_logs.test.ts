/**
 * TDD tests for resource_usage_logs table — issue #164
 *
 * Tests are written first; schema + repository functions are added to make
 * them pass.
 */
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract } from "../../src/db/repositories.js";
import {
    insertResourceUsageLog,
    getResourceUsageLogs,
    getLatestResourceUsageLog,
    type ResourceUsageLog,
} from "../../src/db/repositories.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
const OTHER_CONTRACT_ID = "CAFEBABE5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKABC";

const SAMPLE_LOG = {
    contract_id: CONTRACT_ID,
    cpu_insns: 1_500_000,
    mem_bytes: 524_288,
    fee_instructions: 100,
    fee_read_ledger_entries: 200,
    fee_write_ledger_entries: 300,
    fee_read_bytes: 50,
    fee_write_bytes: 75,
    fee_transaction_size: 25,
    fee_historical_ledger: 10,
    fee_rent_ledger: 40,
    fee_refundable: 60,
} as const;

// ─── Setup ───────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
    db = getDatabaseForTesting();
    insertContract(db, { id: CONTRACT_ID, network: "testnet" });
    insertContract(db, { id: OTHER_CONTRACT_ID, network: "testnet" });
});

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("resource_usage_logs schema", () => {
    it("table exists after DB initialisation", () => {
        const row = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='resource_usage_logs'",
            )
            .get();
        expect(row).toBeDefined();
    });

    it("has an index on contract_id", () => {
        const row = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_resource_usage_logs_contract_id'",
            )
            .get();
        expect(row).toBeDefined();
    });

    it("has an index on recorded_at", () => {
        const row = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_resource_usage_logs_recorded_at'",
            )
            .get();
        expect(row).toBeDefined();
    });

    it("enforces the contracts foreign-key constraint", () => {
        expect(() =>
            db.prepare(`
                INSERT INTO resource_usage_logs
                    (contract_id, cpu_insns, mem_bytes)
                VALUES (?, ?, ?)
            `).run("NONEXISTENT_CONTRACT", 100, 200),
        ).toThrow();
    });
});

// ─── insertResourceUsageLog ───────────────────────────────────────────────────

describe("insertResourceUsageLog", () => {
    it("inserts a full log entry and returns the new row id", () => {
        const id = insertResourceUsageLog(db, SAMPLE_LOG);
        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);
    });

    it("persists all columns correctly", () => {
        const id = insertResourceUsageLog(db, SAMPLE_LOG);
        const row = db
            .prepare("SELECT * FROM resource_usage_logs WHERE id = ?")
            .get(id) as ResourceUsageLog;

        expect(row.contract_id).toBe(CONTRACT_ID);
        expect(row.cpu_insns).toBe(1_500_000);
        expect(row.mem_bytes).toBe(524_288);
        expect(row.fee_instructions).toBe(100);
        expect(row.fee_read_ledger_entries).toBe(200);
        expect(row.fee_write_ledger_entries).toBe(300);
        expect(row.fee_read_bytes).toBe(50);
        expect(row.fee_write_bytes).toBe(75);
        expect(row.fee_transaction_size).toBe(25);
        expect(row.fee_historical_ledger).toBe(10);
        expect(row.fee_rent_ledger).toBe(40);
        expect(row.fee_refundable).toBe(60);
        expect(row.recorded_at).toBeTruthy();
    });

    it("allows optional fee fields to be null", () => {
        const id = insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 800_000,
            mem_bytes: 131_072,
        });
        const row = db
            .prepare("SELECT * FROM resource_usage_logs WHERE id = ?")
            .get(id) as ResourceUsageLog;

        expect(row.cpu_insns).toBe(800_000);
        expect(row.mem_bytes).toBe(131_072);
        expect(row.fee_instructions).toBeNull();
        expect(row.fee_read_ledger_entries).toBeNull();
        expect(row.fee_write_ledger_entries).toBeNull();
        expect(row.fee_read_bytes).toBeNull();
        expect(row.fee_write_bytes).toBeNull();
        expect(row.fee_transaction_size).toBeNull();
        expect(row.fee_historical_ledger).toBeNull();
        expect(row.fee_rent_ledger).toBeNull();
        expect(row.fee_refundable).toBeNull();
    });

    it("allows multiple log entries for the same contract (no unique constraint)", () => {
        insertResourceUsageLog(db, SAMPLE_LOG);
        expect(() => insertResourceUsageLog(db, SAMPLE_LOG)).not.toThrow();

        const rows = db
            .prepare("SELECT * FROM resource_usage_logs WHERE contract_id = ?")
            .all(CONTRACT_ID);
        expect(rows).toHaveLength(2);
    });

    it("rejects an insert for a non-existent contract_id", () => {
        expect(() =>
            insertResourceUsageLog(db, {
                contract_id: "DOES_NOT_EXIST",
                cpu_insns: 1000,
                mem_bytes: 2000,
            }),
        ).toThrow();
    });

    it("accepts zero values for cpu_insns and mem_bytes", () => {
        const id = insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 0,
            mem_bytes: 0,
        });
        const row = db
            .prepare("SELECT * FROM resource_usage_logs WHERE id = ?")
            .get(id) as ResourceUsageLog;
        expect(row.cpu_insns).toBe(0);
        expect(row.mem_bytes).toBe(0);
    });

    it("accepts a caller-supplied recorded_at timestamp", () => {
        const ts = "2025-01-15T12:00:00.000Z";
        const id = insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 500,
            mem_bytes: 1024,
            recorded_at: ts,
        });
        const row = db
            .prepare("SELECT * FROM resource_usage_logs WHERE id = ?")
            .get(id) as ResourceUsageLog;
        expect(row.recorded_at).toBe(ts);
    });
});

// ─── getResourceUsageLogs ─────────────────────────────────────────────────────

describe("getResourceUsageLogs", () => {
    it("returns an empty array when no logs exist for the contract", () => {
        const logs = getResourceUsageLogs(db, CONTRACT_ID);
        expect(logs).toEqual([]);
    });

    it("returns logs ordered by recorded_at descending", () => {
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 100,
            mem_bytes: 200,
            recorded_at: "2025-01-01T10:00:00.000Z",
        });
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 300,
            mem_bytes: 400,
            recorded_at: "2025-01-03T10:00:00.000Z",
        });
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 200,
            mem_bytes: 300,
            recorded_at: "2025-01-02T10:00:00.000Z",
        });

        const logs = getResourceUsageLogs(db, CONTRACT_ID);
        expect(logs).toHaveLength(3);
        expect(logs[0]!.cpu_insns).toBe(300);
        expect(logs[1]!.cpu_insns).toBe(200);
        expect(logs[2]!.cpu_insns).toBe(100);
    });

    it("sorts correctly when mixing default and explicit timestamps", () => {
        // Explicit timestamp in the past
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 100,
            mem_bytes: 100,
            recorded_at: "2020-01-01T00:00:00.000Z",
        });

        // Default timestamp (should be "now" in ISO format, so greater than 2020)
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 200,
            mem_bytes: 200,
        });

        // Explicit timestamp far in the future
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 300,
            mem_bytes: 300,
            recorded_at: "2030-01-01T00:00:00.000Z",
        });

        const logs = getResourceUsageLogs(db, CONTRACT_ID);
        expect(logs).toHaveLength(3);
        // Should be ordered descending: 2030, now, 2020
        expect(logs[0]!.cpu_insns).toBe(300);
        expect(logs[1]!.cpu_insns).toBe(200);
        expect(logs[2]!.cpu_insns).toBe(100);
        // Verify default timestamp format is ISO-8601 UTC
        expect(logs[1]!.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    it("only returns logs for the requested contract", () => {
        insertResourceUsageLog(db, { contract_id: CONTRACT_ID, cpu_insns: 100, mem_bytes: 100 });
        insertResourceUsageLog(db, { contract_id: OTHER_CONTRACT_ID, cpu_insns: 999, mem_bytes: 999 });

        const logs = getResourceUsageLogs(db, CONTRACT_ID);
        expect(logs).toHaveLength(1);
        expect(logs[0]!.cpu_insns).toBe(100);
    });

    it("respects the optional limit parameter", () => {
        for (let i = 0; i < 5; i++) {
            insertResourceUsageLog(db, {
                contract_id: CONTRACT_ID,
                cpu_insns: i * 100,
                mem_bytes: i * 50,
            });
        }

        const logs = getResourceUsageLogs(db, CONTRACT_ID, { limit: 3 });
        expect(logs).toHaveLength(3);
    });

    it("throws when limit is negative", () => {
        expect(() => getResourceUsageLogs(db, CONTRACT_ID, { limit: -1 })).toThrow();
    });

    it("filters by since date when provided", () => {
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 100,
            mem_bytes: 100,
            recorded_at: "2025-01-01T00:00:00.000Z",
        });
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 200,
            mem_bytes: 200,
            recorded_at: "2025-06-01T00:00:00.000Z",
        });

        const logs = getResourceUsageLogs(db, CONTRACT_ID, {
            since: "2025-03-01T00:00:00.000Z",
        });
        expect(logs).toHaveLength(1);
        expect(logs[0]!.cpu_insns).toBe(200);
    });
});

// ─── getLatestResourceUsageLog ────────────────────────────────────────────────

describe("getLatestResourceUsageLog", () => {
    it("returns undefined when no logs exist", () => {
        const log = getLatestResourceUsageLog(db, CONTRACT_ID);
        expect(log).toBeUndefined();
    });

    it("returns the single most-recent log entry", () => {
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 100,
            mem_bytes: 100,
            recorded_at: "2025-01-01T00:00:00.000Z",
        });
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 500,
            mem_bytes: 500,
            recorded_at: "2025-06-01T00:00:00.000Z",
        });

        const log = getLatestResourceUsageLog(db, CONTRACT_ID);
        expect(log).toBeDefined();
        expect(log!.cpu_insns).toBe(500);
    });

    it("is unaffected by logs from other contracts", () => {
        insertResourceUsageLog(db, {
            contract_id: OTHER_CONTRACT_ID,
            cpu_insns: 9999,
            mem_bytes: 9999,
            recorded_at: "2025-12-31T00:00:00.000Z",
        });
        insertResourceUsageLog(db, {
            contract_id: CONTRACT_ID,
            cpu_insns: 42,
            mem_bytes: 42,
            recorded_at: "2025-01-01T00:00:00.000Z",
        });

        const log = getLatestResourceUsageLog(db, CONTRACT_ID);
        expect(log!.cpu_insns).toBe(42);
    });
});
