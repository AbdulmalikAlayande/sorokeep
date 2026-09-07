import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerCheckCommand } from "../../src/commands/check";
import { insertContract, upsertEntry, updateLastCheckedLedger } from "../../src/db/repositories";
import ora from "ora";

const { mockSpinner } = vi.hoisted(() => {
    return {
        mockSpinner: {
            start: vi.fn().mockReturnThis(),
            succeed: vi.fn().mockReturnThis(),
            fail: vi.fn().mockReturnThis(),
            text: "",
            isSpinning: true,
        },
    };
});

vi.mock("ora", () => ({
    default: vi.fn(() => mockSpinner),
}));

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("check command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: any;
    let exitSpy: any;

    beforeEach(() => {
        mockSpinner.start.mockReturnThis();
        mockSpinner.succeed.mockReturnThis();
        mockSpinner.fail.mockReturnThis();
        mockSpinner.text = "";
        mockSpinner.isSpinning = true;
        vi.mocked(ora).mockReturnValue(mockSpinner as any);

        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("exits with code 0 when all TTLs are above the fail-under threshold", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAAB",
            entry_type: "wasm",
            live_until_ledger: 600000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "100000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with code 1 when any TTL is below the fail-under threshold", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAAB",
            entry_type: "wasm",
            live_until_ledger: 405000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "100000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with code 1 when contract is not registered", () => {
        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                "--fail-under",
                "1000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with code 0 when there are no entries for the contract", () => {
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "1000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("exits with code 0 when fail-under is exactly equal to an entry TTL", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 401000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "1000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("outputs TTL information for each entry without spinners", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "100000",
            ]);
        }).toThrow("process.exit called");

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("TTL:")
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("100,000")
        );
    });

    it("exits with code 0 and prints warning when any TTL is below the fail-under threshold but --force is used", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAAB",
            entry_type: "wasm",
            live_until_ledger: 405000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "100000",
                "--force",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("CI checks bypassed with --force"));
    });

    it("starts ora spinner, updates text for entries, and calls succeed when safe", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAAB",
            entry_type: "wasm",
            live_until_ledger: 600000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "50000",
            ]);
        }).toThrow("process.exit called");

        expect(ora).toHaveBeenCalledWith(expect.stringContaining("sample-contract"));
        expect(mockSpinner.start).toHaveBeenCalled();
        expect(mockSpinner.succeed).toHaveBeenCalledWith(expect.stringContaining("All TTLs are safe."));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("calls spinner.fail when TTL health check fails", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 405000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "50000",
            ]);
        }).toThrow("process.exit called");

        expect(mockSpinner.fail).toHaveBeenCalledWith(expect.stringContaining("TTL health check failed"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls spinner.fail when an unhandled error is thrown during check", () => {
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });

        // Let getContract succeed, but make getEntriesForContract throw
        let callCount = 0;
        const origPrepare = mockDb.prepare.bind(mockDb);
        vi.spyOn(mockDb, "prepare").mockImplementation((...args: any[]) => {
            callCount++;
            if (callCount >= 2) {
                throw new Error("Database query corrupted");
            }
            return origPrepare(...args as [string]);
        });

        const program = new Command();
        registerCheckCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
                "check",
                contractID,
                "--fail-under",
                "50000",
            ]);
        }).toThrow("process.exit called");

        expect(mockSpinner.fail).toHaveBeenCalledWith(expect.stringContaining("Database query corrupted"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
