import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
