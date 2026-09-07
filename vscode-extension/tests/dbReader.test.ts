import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
// Database is still imported for its `Options`/instance types used via openSorokeepDb.
import {
    createFixtureDb,
    TRACKED_CONTRACT_ID,
    UNTRACKED_CONTRACT_ID,
} from "./helpers/fixture.js";
import { openSorokeepDb, readContractStatus } from "../src/dbReader.js";

let seed: (db: Database.Database) => number;

function stubSeed() {
    return (db: Database.Database) => {
        db.prepare(
            `INSERT INTO contracts (id, name, network, last_checked_ledger) VALUES (?, ?, 'testnet', ?)`,
        ).run(TRACKED_CONTRACT_ID, "USD Stablecoin Gateway", 2_400_000);
        db.prepare(
            `INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, label, live_until_ledger) VALUES (?, ?, 'instance', 'Contract Instance', ?)`,
        ).run(TRACKED_CONTRACT_ID, "AAAAinstance", 2_410_000);
        db.prepare(
            `INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, label, live_until_ledger) VALUES (?, ?, 'wasm', 'WASM Code', ?)`,
        ).run(TRACKED_CONTRACT_ID, "AAAAwasm", 2_404_000);
        return 2_400_000;
    };
}

describe("readContractStatus", () => {
    beforeEach(() => {
        seed = stubSeed();
    });

    it("returns remaining TTL + status per entry for a tracked contract", () => {
        const db = createFixtureDb();
        seed(db);

        const status = readContractStatus(db, TRACKED_CONTRACT_ID)!;
        expect(status).not.toBeNull();
        expect(status.contractId).toBe(TRACKED_CONTRACT_ID);
        expect(status.network).toBe("testnet");
        expect(status.lastCheckedLedger).toBe(2_400_000);

        // instance: live 2,410,000 - checked 2,400,000 = 10,000 → warning
        // wasm:    live 2,404,000 - checked 2,400,000 =   4,000 → critical
        const byLabel = new Map(status.entries.map((e) => [e.label, e]));
        expect(byLabel.get("Contract Instance")!.remainingTTL).toBe(10_000);
        expect(byLabel.get("Contract Instance")!.status).toBe("warning");
        expect(byLabel.get("WASM Code")!.remainingTTL).toBe(4_000);
        expect(byLabel.get("WASM Code")!.status).toBe("critical");
        expect(byLabel.get("WASM Code")!.approximateTimeRemaining).toBe("~6h 6m");
    });

    it("returns null for a contract ID that is not tracked (no lens -> no false positive)", () => {
        const db = createFixtureDb();
        seed(db);
        expect(readContractStatus(db, UNTRACKED_CONTRACT_ID)).toBeNull();
    });

    it("returns entries with unknown status when the contract was never polled", () => {
        const db = createFixtureDb();
        db.prepare(
            `INSERT INTO contracts (id, name, network, last_checked_ledger) VALUES (?, ?, 'testnet', NULL)`,
        ).run(TRACKED_CONTRACT_ID, "Never Polled");
        db.prepare(
            `INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, live_until_ledger) VALUES (?, ?, 'instance', ?)`,
        ).run(TRACKED_CONTRACT_ID, "AAAAinstance", 2_410_000);

        const status = readContractStatus(db, TRACKED_CONTRACT_ID)!;
        expect(status.entries[0]!.remainingTTL).toBeNull();
        expect(status.entries[0]!.status).toBe("unknown");
    });
});

describe("openSorokeepDb (read-only access, WAL-safe)", () => {
    let dir: string;
    let dbFilePath: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-ext-"));
        dbFilePath = path.join(dir, "sorokeep.db");
    });

    it("opens a fixture database read-only and reads TTL status", () => {
        const db = createFixtureDb(dbFilePath);
        seed(db);
        // Commit + close while keeping a WAL: a read-only open must succeed
        // even though a daemon might later write to the same file in WAL mode.
        db.pragma("journal_mode = WAL");
        db.close();

        const opened = openSorokeepDb(dbFilePath, { readMode: "readonly" })!;
        const status = readContractStatus(opened, TRACKED_CONTRACT_ID)!;
        expect(status.entries.length).toBeGreaterThan(0);
        opened.close();
    });

    it("returns null for a missing database file (no crash)", () => {
        expect(openSorokeepDb(path.join(dir, "does-not-exist.db"), { readMode: "readonly" })).toBeNull();
    });

    it("returns null when the database cannot be opened (no crash)", () => {
        expect(openSorokeepDb(dbFilePath, { readMode: "readonly" })).toBeNull();
    });

    it("immutable mode can read a fixture file", () => {
        const db = createFixtureDb(dbFilePath);
        seed(db);
        db.close();

        const opened = openSorokeepDb(dbFilePath, { readMode: "immutable" })!;
        expect(readContractStatus(opened, TRACKED_CONTRACT_ID)).not.toBeNull();
        opened.close();
    });
});