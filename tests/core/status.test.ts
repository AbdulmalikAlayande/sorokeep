import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertEntry } from "../../src/db/repositories.js";
import {
    getContractStatus,
    ContractNotFoundError,
} from "../../src/core/status.js";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

describe("getContractStatus", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("returns contract metadata and entry TTL lifespans", () => {
        insertContract(db, {
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });
        db.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            2_500_000,
            CONTRACT_ID,
        );
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "instance-key",
            entry_type: "instance",
            live_until_ledger: 2_520_000,
            discovery_source: "deterministic",
        });
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "wasm-key",
            entry_type: "wasm",
            live_until_ledger: 2_510_000,
            discovery_source: "deterministic",
        });

        const status = getContractStatus(db, CONTRACT_ID);

        expect(status).toEqual({
            contractId: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 2_500_000,
            entries: [
                {
                    label: "Instance",
                    entryType: "instance",
                    entryKeyXdr: "instance-key",
                    liveUntilLedger: 2_520_000,
                    remainingTTL: 20_000,
                    approximateTimeRemaining: "~1d 6h",
                    status: "ok",
                },
                {
                    label: "WASM Code",
                    entryType: "wasm",
                    entryKeyXdr: "wasm-key",
                    liveUntilLedger: 2_510_000,
                    remainingTTL: 10_000,
                    approximateTimeRemaining: "~15h 16m",
                    status: "warning",
                },
            ],
        });
    });

    it("throws ContractNotFoundError for an unregistered contract", () => {
        expect(() => getContractStatus(db, CONTRACT_ID)).toThrow(ContractNotFoundError);
    });

    it("returns unknown TTL when live_until_ledger is missing", () => {
        insertContract(db, { id: CONTRACT_ID, network: "testnet" });
        db.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            2_500_000,
            CONTRACT_ID,
        );
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "persistent-key",
            entry_type: "persistent",
            label: "balance",
            discovery_source: "manual",
        });

        const status = getContractStatus(db, CONTRACT_ID);

        expect(status.entries).toHaveLength(1);
        expect(status.entries[0]).toMatchObject({
            label: "balance",
            entryType: "persistent",
            liveUntilLedger: null,
            remainingTTL: null,
            approximateTimeRemaining: null,
            status: "unknown",
        });
    });

    it("returns unknown TTL when last_checked_ledger is missing", () => {
        insertContract(db, { id: CONTRACT_ID, network: "testnet" });
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "instance-key",
            entry_type: "instance",
            live_until_ledger: 2_520_000,
            discovery_source: "deterministic",
        });

        const status = getContractStatus(db, CONTRACT_ID);

        expect(status.lastCheckedLedger).toBeNull();
        expect(status.entries[0]?.status).toBe("unknown");
    });

    it("classifies expired TTL when remaining ledgers are zero or negative", () => {
        insertContract(db, { id: CONTRACT_ID, network: "testnet" });
        db.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            2_500_000,
            CONTRACT_ID,
        );
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "instance-key",
            entry_type: "instance",
            live_until_ledger: 2_499_000,
            discovery_source: "deterministic",
        });

        const status = getContractStatus(db, CONTRACT_ID);

        expect(status.entries[0]).toMatchObject({
            remainingTTL: -1_000,
            approximateTimeRemaining: "Ledger Expired",
            status: "expired",
        });
    });

    it("returns an empty entries array when no entries are tracked", () => {
        insertContract(db, { id: CONTRACT_ID, network: "testnet" });

        const status = getContractStatus(db, CONTRACT_ID);

        expect(status.entries).toEqual([]);
    });
});
