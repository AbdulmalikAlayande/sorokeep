import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerStatusCommand } from "../../src/commands/status";
import { insertContract, upsertEntry, updateLastCheckedLedger } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("status command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        updateLastCheckedLedger(mockDb, contractID, 400000);

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
import { registerStatusCommand } from "../../src/commands/status";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import { ContractNotFoundError } from "../../src/core/status";
import * as statusModule from "../../src/core/status";

vi.mock("../../src/db/database");

describe("Status Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockLog: any;
    let actionFn: (contractId: string) => void;

    beforeEach(() => {
        program = new Command();

        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });

        registerStatusCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prints JSON payload when --json is provided", () => {
        const program = new Command();
        registerStatusCommand(program);

        program.parse(["node", "sorokeep", "status", contractID, "--json"]);

        const output = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        const parsed = JSON.parse(output);

        expect(parsed).toMatchObject({
            contractId: contractID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 400000,
        });
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0]).toMatchObject({
            label: "Instance",
            entryType: "instance",
        });
        expect(typeof parsed.entries[0].status).toBe("string");
        expect(output).not.toContain("\u001b[");
    });

    it("prints human-readable output by default", () => {
        const program = new Command();
        registerStatusCommand(program);

        program.parse(["node", "sorokeep", "status", contractID]);

        const output = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n");

        expect(output).toContain("Network:");
        expect(output).toContain("TTL:");
        expect(output).not.toContain("\"contractId\"");
    it("exits with code 1 if contract is not found (ContractNotFoundError)", () => {
        vi.spyOn(statusModule, "getContractStatus").mockImplementation(() => {
            throw new ContractNotFoundError("MISSING_ID");
        });

        actionFn("MISSING_ID");

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("is not registered"));
    });

    it("re-throws unknown errors", () => {
        vi.spyOn(statusModule, "getContractStatus").mockImplementation(() => {
            throw new Error("DB Corrupt");
        });

        expect(() => actionFn("VALID_ID")).toThrow("DB Corrupt");
    });

    it("prints 'No entries tracked' for a contract with empty entries", () => {
        vi.spyOn(statusModule, "getContractStatus").mockReturnValue({
            contractId: "VALID_ID",
            name: "MyContract",
            network: "testnet",
            lastCheckedLedger: null,
            entries: [],
        });

        actionFn("VALID_ID");
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No entries tracked"));
    });

    it("prints TTL info for tracked entries", () => {
        vi.spyOn(statusModule, "getContractStatus").mockReturnValue({
            contractId: "VALID_ID",
            name: "MyContract",
            network: "testnet",
            lastCheckedLedger: 123456,
            entries: [
                { label: "WASM Code", entryType: "wasm", entryKeyXdr: "AAAA", liveUntilLedger: 173456, remainingTTL: 50000, approximateTimeRemaining: "~3.2 days", status: "ok" },
                { label: "Instance", entryType: "instance", entryKeyXdr: "BBBB", liveUntilLedger: null, remainingTTL: null, approximateTimeRemaining: null, status: "unknown" },
            ],
        });

        actionFn("VALID_ID");
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("MyContract"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("testnet"));
    });

    it("displays last checked ledger when available", () => {
        vi.spyOn(statusModule, "getContractStatus").mockReturnValue({
            contractId: "VALID_ID",
            name: "MyContract",
            network: "testnet",
            lastCheckedLedger: 999999,
            entries: [
                { label: "WASM Code", entryType: "wasm", entryKeyXdr: "AAAA", liveUntilLedger: 1099999, remainingTTL: 100000, approximateTimeRemaining: "~6.4 days", status: "ok" },
            ],
        });

        actionFn("VALID_ID");
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("999,999"));
    });

    it("handles contract with no name (uses formatted ID)", () => {
        vi.spyOn(statusModule, "getContractStatus").mockReturnValue({
            contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
            name: null,
            network: "testnet",
            lastCheckedLedger: null,
            entries: [],
        });

        actionFn("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6");
        expect(mockLog).toHaveBeenCalled();
    });
});
