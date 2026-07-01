import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerCostsCommand } from "../../src/commands/costs";
import { insertContract, upsertEntry, recordExtension } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("costs command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        const entry = upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAAA",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });

        recordExtension(mockDb, {
            contract_id: contractID,
            contract_entry_id: 1,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 5000,
            tx_hash: "txhash1234567890",
            cost_xlm: 1.25,
            executed_at_ledger: 410000,
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
import { registerCostsCommand } from "../../src/commands/costs";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as costsLib from "../../src/core/costs";

vi.mock("../../src/db/database");
vi.mock("../../src/core/costs");
vi.mock("../../src/rpc/client");

describe("Costs Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockError: any;
    let mockLog: any;
    let actionFn: (contractId: string, options: any) => Promise<void>;

    beforeEach(() => {
        program = new Command();

        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });

        registerCostsCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prints JSON payload when --json is provided", async () => {
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", contractID, "--json"]);

        const output = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        const parsed = JSON.parse(output);

        expect(parsed).toMatchObject({
            contract: {
                id: contractID,
                name: "sample-contract",
                network: "testnet",
            },
            summary: {
                totalExtensions: 1,
                totalCostXlm: 1.25,
            },
        });
        expect(parsed.recentExtensions).toHaveLength(1);
        expect(output).not.toContain("\u001b[");
    });

    it("prints human-readable output by default", async () => {
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", contractID]);

        const output = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n");

        expect(output).toContain("Extension History");
        expect(output).toContain("Summary");
        expect(output).not.toContain("\"contract\"");
    it("exits with 1 if --period is not a positive integer", async () => {
        await actionFn("VALID_ID", { period: "abc" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--period must be a positive integer"));
    });

    it("exits with 1 if --period is zero", async () => {
        await actionFn("VALID_ID", { period: "0" });
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("exits with 1 if --period is negative", async () => {
        await actionFn("VALID_ID", { period: "-5" });
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("exits with 1 when contract is not found", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: false,
            error: "contract_not_found",
        } as any);

        await actionFn("MISSING_ID", { period: "30" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("displays cost summary for a valid contract", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: true,
            data: {
                contract: { name: "MyContract", network: "testnet" },
                period: { label: "Last 30 days" },
                message: null,
                summary: {
                    totalExtensions: 5,
                    totalCostXlm: 0.05,
                },
                byEntryType: {
                    wasm: { count: 3, costXlm: 0.03 },
                    instance: { count: 2, costXlm: 0.02 },
                },
                recentExtensions: [],
            },
        } as any);
        vi.mocked(costsLib.calculateFeeAdjustedProjection).mockReturnValue({
            adjustedProjectedCostXlm: 0.05,
            surgePricingMultiplier: 1.0,
        } as any);

        await actionFn("VALID_ID", { period: "30" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("MyContract"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Total extensions"));
    });

    it("displays message when no extensions found", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: true,
            data: {
                contract: { name: "MyContract", network: "testnet" },
                period: { label: "Last 30 days" },
                message: "No extensions found in this period",
                summary: { totalExtensions: 0, totalCostXlm: 0 },
                byEntryType: {},
                recentExtensions: [],
            },
        } as any);

        await actionFn("VALID_ID", { period: "30" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No extensions found"));
    });

    it("passes --all flag correctly to skip period parsing", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: true,
            data: {
                contract: { name: "Test", network: "testnet" },
                period: { label: "All time" },
                message: "No extensions found",
                summary: { totalExtensions: 0, totalCostXlm: 0 },
                byEntryType: {},
                recentExtensions: [],
            },
        } as any);

        await actionFn("VALID_ID", { all: true, period: "30" });
        expect(costsLib.getExtensionCosts).toHaveBeenCalledWith(
            expect.anything(),
            "VALID_ID",
            expect.objectContaining({ all: true })
        );
    });

    it("handles thrown errors gracefully", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockImplementation(() => {
            throw new Error("DB connection lost");
        });

        await actionFn("VALID_ID", { period: "30" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("DB connection lost"));
    });
});
