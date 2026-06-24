import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerCheckCommand } from "../../src/commands/check";
import { insertContract, upsertEntry, insertAlertConfig } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("check command", () => {
    const contractId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: any;
    let consoleErrorSpy: any;
    let exitSpy: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exits with 0 when no contracts are registered", () => {
        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with 0 when no contracts have entries", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with 0 when all entries have TTL above all alert thresholds", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-1",
            entry_type: "instance",
            live_until_ledger: 50000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with 1 when an entry's TTL is below an alert threshold", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-1",
            entry_type: "instance",
            live_until_ledger: 5000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with 1 when an entry's TTL equals the threshold exactly (boundary)", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-1",
            entry_type: "instance",
            live_until_ledger: 10000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with 1 when multiple entries' TTLs are below thresholds", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-instance",
            entry_type: "instance",
            live_until_ledger: 3000,
        });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-wasm",
            entry_type: "wasm",
            live_until_ledger: 5000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with 0 when no threshold is crossed even with stale entries (no alert configs)", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-1",
            entry_type: "instance",
            live_until_ledger: 100,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with 0 when a contract has no entries but has alert configs", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("reports summary with counts of healthy and crossed TTLs", () => {
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-healthy",
            entry_type: "instance",
            live_until_ledger: 50000,
        });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-crossed",
            entry_type: "wasm",
            live_until_ledger: 5000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("1"),
        );
    });

    it("handles multiple contracts independently", () => {
        const contractId2 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
        insertContract(mockDb, { id: contractId, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId,
            entry_key_xdr: "key-1",
            entry_type: "instance",
            live_until_ledger: 50000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        insertContract(mockDb, { id: contractId2, network: "testnet" });
        upsertEntry(mockDb, {
            contract_id: contractId2,
            entry_key_xdr: "key-2",
            entry_type: "instance",
            live_until_ledger: 5000,
        });
        insertAlertConfig(mockDb, {
            contract_id: contractId2,
            channel_type: "webhook",
            channel_target: "https://hooks.example.com",
            threshold_ledgers: 10000,
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
