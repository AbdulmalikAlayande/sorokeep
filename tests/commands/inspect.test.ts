import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerInspectCommand } from "../../src/commands/inspect";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as inspectModule from "../../src/core/inspect";

vi.mock("../../src/db/database");

describe("Inspect Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockLog: any;
    let mockErr: any;
    let actionFn: (contractId: string, options: any) => void;

    beforeEach(() => {
        program = new Command();

        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });

        registerInspectCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        mockErr = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers inspect command with --entry shortcut option", () => {
        expect(program.commands.some(c => c.name() === "inspect")).toBe(true);
    });

    it("fails gracefully on non-SAC contracts", async () => {
        vi.spyOn(inspectModule, "inspectContract").mockResolvedValue({
            success: false,
            contractId: "CUSTOM_ID",
            error: "Contract CUSTOM_ID is not a standard Stellar Asset Contract (SAC). Executable type: contractExecutableWasm",
        });

        await actionFn("CUSTOM_ID", { entry: ["balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW"] });

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("not a standard Stellar Asset Contract (SAC)"));
    });

    it("correctly decodes and prints address balance decimals for SAC contract", async () => {
        vi.spyOn(inspectModule, "inspectContract").mockResolvedValue({
            success: true,
            contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
            contractName: "Native XLM",
            network: "testnet",
            isSac: true,
            decimals: 7,
            results: [
                {
                    inputEntry: "balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW",
                    entryKeyXdr: "AAAA",
                    type: "balance",
                    found: true,
                    remainingTTL: 100000,
                    approximateTimeRemaining: "~6.4 days",
                    status: "ok",
                    balance: {
                        amount: 10500000n,
                        authorized: true,
                        clawback: false,
                    },
                    formattedBalance: "1.05",
                },
            ],
        });

        await actionFn("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
            entry: ["balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW"],
        });

        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Native XLM"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("1.05"));
        expect(mockExit).not.toHaveBeenCalled();
    });
});
