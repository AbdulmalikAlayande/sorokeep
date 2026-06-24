import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertEntry } from "../../src/db/repositories.js";
import { registerCheckCommand } from "../../src/commands/check";

const mockGetEntryTTLs = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getEntryTTLs = mockGetEntryTTLs;
        checkHealth = vi.fn().mockResolvedValue({ status: "healthy", latestLedger: 1000 });
        getNetwork = vi.fn().mockReturnValue("testnet");
    }
    return {
        StellarRpcClient: MockStellarRpcClient,
    };
});

describe("check command --force flag", () => {
    let db: Database.Database;
    const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: any;
    let exitSpy: any;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();

        insertContract(db, { id: CONTRACT_ID, network: "testnet", name: "sample" });
        // Add one entry for the contract
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "instance-key-xdr",
            entry_type: "instance",
            live_until_ledger: 1001,
            last_modified_ledger: 900,
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exits non-zero when TTL is low without --force", () => {
        // Simulate low TTLs from RPC
        mockGetEntryTTLs.mockResolvedValue({ latestLedger: 1000, entries: [{ entryKeyXdr: "instance-key-xdr", latestLedger: 1000, liveUntilLedgerSeq: 1001, lastModifiedLedgerSeq: 900, remainingTTL: 1 }] });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check", CONTRACT_ID]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits 0 and prints warning when TTL is low with --force", () => {
        mockGetEntryTTLs.mockResolvedValue({ latestLedger: 1000, entries: [{ entryKeyXdr: "instance-key-xdr", latestLedger: 1000, liveUntilLedgerSeq: 1001, lastModifiedLedgerSeq: 900, remainingTTL: 1 }] });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "check", CONTRACT_ID, "--force"]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("CI checks bypassed with --force"));
    });
});
