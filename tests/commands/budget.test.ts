/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBudgetCommand } from "../../src/commands/budget";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as budgetModule from "../../src/core/budget";

vi.mock("../../src/db/database");

describe("Budget Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockLog: any;

    beforeEach(() => {
        program = new Command();
        registerBudgetCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("set", () => {
        it("should write budget configuration to DB", () => {
            const setSpy = vi.spyOn(budgetModule, "setContractBudget").mockImplementation(() => {});
            
            program.parse(["node", "test", "budget", "set", "--contract", "C123", "--limit", "500"]);

            expect(setSpy).toHaveBeenCalledWith(expect.anything(), "C123", 500);
            expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Budget set to 500 XLM"));
        });
    });

    describe("status", () => {
        it("should display current spend progress bar", () => {
            vi.spyOn(budgetModule, "getMonthlySpendProgress").mockReturnValue({
                limit: 100,
                spend: 25,
                percentage: 25
            });

            program.parse(["node", "test", "budget", "status", "C123"]);

            expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("25.00 / 100.00 XLM"));
            expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("25.0%"));
            // progress bar characters
            expect(mockLog).toHaveBeenCalledWith(expect.stringMatching(/█/));
        });
    });
});
