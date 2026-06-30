import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
        vi.mocked(costsLib.getMultiPeriodCosts).mockReturnValue({
            success: true,
            data: {
                contract: { id: "VALID_ID", name: "MyContract", network: "testnet" },
                periods: [
                    { days: 7, totalExtensions: 1, totalCostXlm: 0.01 },
                    { days: 30, totalExtensions: 5, totalCostXlm: 0.05 },
                    { days: 90, totalExtensions: 5, totalCostXlm: 0.05 },
                ],
                projection: { baseProjectedCostXlm: 0.05, adjustedProjectedCostXlm: 0.05, baseFeeMultiplier: 1, surgePricingMultiplier: 1 },
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
        vi.mocked(costsLib.getMultiPeriodCosts).mockReturnValue({
            success: true,
            data: {
                contract: { id: "VALID_ID", name: "MyContract", network: "testnet" },
                periods: [
                    { days: 7, totalExtensions: 0, totalCostXlm: 0 },
                    { days: 30, totalExtensions: 0, totalCostXlm: 0 },
                    { days: 90, totalExtensions: 0, totalCostXlm: 0 },
                ],
                projection: { baseProjectedCostXlm: 0, adjustedProjectedCostXlm: 0, baseFeeMultiplier: 1, surgePricingMultiplier: 1 },
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
        vi.mocked(costsLib.getMultiPeriodCosts).mockReturnValue({
            success: true,
            data: {
                contract: { id: "VALID_ID", name: "Test", network: "testnet" },
                periods: [
                    { days: 7, totalExtensions: 0, totalCostXlm: 0 },
                    { days: 30, totalExtensions: 0, totalCostXlm: 0 },
                    { days: 90, totalExtensions: 0, totalCostXlm: 0 },
                ],
                projection: { baseProjectedCostXlm: 0, adjustedProjectedCostXlm: 0, baseFeeMultiplier: 1, surgePricingMultiplier: 1 },
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

    it("displays multi-period historical costs table by default (no --period)", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: true,
            data: {
                contract: { name: "MyContract", network: "testnet" },
                period: { label: "last 30 days" },
                message: null,
                summary: { totalExtensions: 5, totalCostXlm: 0.05 },
                byEntryType: {},
                recentExtensions: [],
            },
        } as any);
        vi.mocked(costsLib.calculateFeeAdjustedProjection).mockReturnValue({
            adjustedProjectedCostXlm: 0.05,
            surgePricingMultiplier: 1.0,
        } as any);
        vi.mocked(costsLib.getMultiPeriodCosts).mockReturnValue({
            success: true,
            data: {
                contract: { id: "VALID_ID", name: "MyContract", network: "testnet" },
                periods: [
                    { days: 7, totalExtensions: 2, totalCostXlm: 0.01 },
                    { days: 30, totalExtensions: 5, totalCostXlm: 0.05 },
                    { days: 90, totalExtensions: 12, totalCostXlm: 0.12 },
                ],
                projection: {
                    baseProjectedCostXlm: 0.05,
                    adjustedProjectedCostXlm: 0.05,
                    baseFeeMultiplier: 1,
                    surgePricingMultiplier: 1,
                },
            },
        } as any);

        await actionFn("VALID_ID", { period: "30" });
        expect(costsLib.getMultiPeriodCosts).toHaveBeenCalled();
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("MyContract"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("7 days"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("30 days"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("90 days"));
    });

    it("displays 30-day projection estimate in the table", async () => {
        vi.mocked(costsLib.getExtensionCosts).mockReturnValue({
            success: true,
            data: {
                contract: { name: "MyContract", network: "testnet" },
                period: { label: "last 30 days" },
                message: null,
                summary: { totalExtensions: 3, totalCostXlm: 0.03 },
                byEntryType: {},
                recentExtensions: [],
            },
        } as any);
        vi.mocked(costsLib.calculateFeeAdjustedProjection).mockReturnValue({
            adjustedProjectedCostXlm: 0.045,
            surgePricingMultiplier: 1.5,
        } as any);
        vi.mocked(costsLib.getMultiPeriodCosts).mockReturnValue({
            success: true,
            data: {
                contract: { id: "VALID_ID", name: "MyContract", network: "testnet" },
                periods: [
                    { days: 7, totalExtensions: 1, totalCostXlm: 0.01 },
                    { days: 30, totalExtensions: 3, totalCostXlm: 0.03 },
                    { days: 90, totalExtensions: 8, totalCostXlm: 0.08 },
                ],
                projection: {
                    baseProjectedCostXlm: 0.03,
                    adjustedProjectedCostXlm: 0.045,
                    baseFeeMultiplier: 1,
                    surgePricingMultiplier: 1.5,
                },
            },
        } as any);

        await actionFn("VALID_ID", { period: "30" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Projection"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("0.0450000"));
    });
});
