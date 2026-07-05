import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import { ContractNotFoundError } from "../../src/core/status";
import * as statusModule from "../../src/core/status";
import { registerStatusCommand } from "../../src/commands/status";

vi.mock("../../src/db/database", () => ({
    getDatabase: vi.fn(),
}));

vi.mock("../../src/core/status", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/core/status")>();
    return {
        ...actual,
        getContractStatus: vi.fn(),
    };
});

describe("status command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let actionFn: (contractId: string, options: { json?: boolean }) => void;
    let mockExit: ReturnType<typeof vi.spyOn>;
    let mockLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        const program = new Command();
        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });

        registerStatusCommand(program);
        mockExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.mocked(dbLib.getDatabase).mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prints JSON payload when --json is provided", () => {
        vi.mocked(statusModule.getContractStatus).mockReturnValue({
            contractId: contractID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 400000,
            entries: [
                {
                    label: "Instance",
                    entryType: "instance",
                    entryKeyXdr: "AAAAA",
                    liveUntilLedger: 500000,
                    remainingTTL: 100000,
                    approximateTimeRemaining: "~1 day",
                    status: "ok",
                },
            ],
        } as any);

        actionFn(contractID, { json: true });

        const output = mockLog.mock.calls.map((args) => args.join(" ")).join("\n");
        const parsed = JSON.parse(output);

        expect(parsed).toMatchObject({
            contractId: contractID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 400000,
        });
        expect(parsed.entries).toHaveLength(1);
        expect(output).not.toContain("\u001b[");
    });

    it("prints human-readable output by default", () => {
        vi.mocked(statusModule.getContractStatus).mockReturnValue({
            contractId: contractID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 400000,
            entries: [
                {
                    label: "Instance",
                    entryType: "instance",
                    entryKeyXdr: "AAAAA",
                    liveUntilLedger: 500000,
                    remainingTTL: 100000,
                    approximateTimeRemaining: "~1 day",
                    status: "ok",
                },
            ],
        } as any);

        actionFn(contractID, { json: false });

        const output = mockLog.mock.calls.map((args) => args.join(" ")).join("\n");

        expect(output).toContain("Network:");
        expect(output).toContain("TTL:");
        expect(output).not.toContain("\"contractId\"");
    });

    it("exits with code 1 if contract is not found", () => {
        vi.mocked(statusModule.getContractStatus).mockImplementation(() => {
            throw new ContractNotFoundError("MISSING_ID");
        });

        actionFn("MISSING_ID", { json: false });

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("is not registered"));
    });

    it("re-throws unknown errors", () => {
        vi.mocked(statusModule.getContractStatus).mockImplementation(() => {
            throw new Error("DB Corrupt");
        });

        expect(() => actionFn("VALID_ID", { json: false })).toThrow("DB Corrupt");
    });
});
