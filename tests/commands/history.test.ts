import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerHistoryCommand } from "../../src/commands/history";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    insertStateSnapshot,
    insertStateChange,
} from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("history command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        mockDb.close();
        vi.restoreAllMocks();
    });

    function seedContractWithHistory() {
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "key-xdr-1",
            entry_type: "persistent",
            label: "counter",
        });

        const entryId = getEntriesForContract(mockDb, contractID)[0]!.id;

        // Create first snapshot and state change (created)
        const snap1Id = insertStateSnapshot(mockDb, {
            contract_entry_id: entryId,
            snapshot_ledger: 1000,
            value_hash: "hash1",
            value_xdr: "AAAAAQ==",
        });

        insertStateChange(mockDb, {
            contract_entry_id: entryId,
            new_snapshot_id: snap1Id,
            diff_type: "created",
            diff_json: JSON.stringify({
                diffType: "created",
                oldValueXdr: null,
                newValueXdr: "AAAAAQ==",
            }),
            detected_at_ledger: 1000,
        });

        // Create second snapshot and state change (updated)
        const snap2Id = insertStateSnapshot(mockDb, {
            contract_entry_id: entryId,
            snapshot_ledger: 1100,
            value_hash: "hash2",
            value_xdr: "AAAAAg==",
        });

        insertStateChange(mockDb, {
            contract_entry_id: entryId,
            old_snapshot_id: snap1Id,
            new_snapshot_id: snap2Id,
            diff_type: "updated",
            diff_json: JSON.stringify({
                diffType: "updated",
                oldValueXdr: "AAAAAQ==",
                newValueXdr: "AAAAAg==",
            }),
            detected_at_ledger: 1100,
        });

        return entryId;
    }

    it("prints clean change history for a contract with state changes", () => {
        seedContractWithHistory();

        const program = new Command();
        registerHistoryCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "history",
            contractID,
        ]);

        // Should print the contract name/ID
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("sample-contract"),
        );

        // Should show the entry label
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("counter"),
        );
    });

    it("shows diff type and old/new values", () => {
        seedContractWithHistory();

        const program = new Command();
        registerHistoryCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "history",
            contractID,
        ]);

        // Check for diff types in output
        const allOutput = consoleLogSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");

        // Should mention 'updated' and 'created' types
        expect(allOutput).toContain("updated");
        expect(allOutput).toContain("created");
    });

    it("shows old and new XDR values", () => {
        seedContractWithHistory();

        const program = new Command();
        registerHistoryCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "history",
            contractID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");

        // Should show the XDR values
        expect(allOutput).toContain("AAAAAQ==");
        expect(allOutput).toContain("AAAAAg==");
    });

    it("respects --limit option", () => {
        seedContractWithHistory();

        const program = new Command();
        registerHistoryCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "history",
            contractID,
            "--limit",
            "1",
        ]);

        // Count lines that contain diff type indicators (updated/created/deleted)
        const diffLines = consoleLogSpy.mock.calls.filter(
            (c: any[]) => {
                const line = c.join(" ");
                return line.includes("updated") || line.includes("created") || line.includes("deleted");
            },
        );

        // With limit 1, should show at most 1 state change
        expect(diffLines.length).toBeLessThanOrEqual(1);
    });

    it("handles contract with no state changes gracefully", () => {
        insertContract(mockDb, {
            id: contractID,
            name: "empty-contract",
            network: "testnet",
        });

        const program = new Command();
        registerHistoryCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "history",
            contractID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
        expect(allOutput).toContain("No state change history");
    });

    it("errors on unregistered contract", () => {
        const program = new Command();
        registerHistoryCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "history",
                "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining("not registered"),
        );
    });
});
