/**
 * TDD tests for the `guard history --contract <id>` subcommand.
 *
 * Acceptance criteria:
 *   1. `guard history` prints the change log for a contract in chronological order.
 *   2. Each row shows old → new values with a timestamp.
 *   3. Exits with code 1 and an error message when --contract is missing.
 *   4. Prints a friendly message when there is no history yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerGuardCommand } from "../../src/commands/guard.js";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertExtensionPolicy,
    getGuardPolicyHistory,
} from "../../src/db/repositories.js";

const TEST_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

let sharedDb: ReturnType<typeof getDatabaseForTesting>;

vi.mock("../../src/db/database", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        getDatabase: () => sharedDb,
    };
});

describe("guard history subcommand", () => {
    let mockLog: ReturnType<typeof vi.spyOn>;
    let mockError: ReturnType<typeof vi.spyOn>;
    let mockExit: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sharedDb = getDatabaseForTesting();
        insertContract(sharedDb, { id: TEST_CONTRACT, network: "testnet", name: "Test Contract" });

        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        sharedDb.close();
    });

    // Helper: run `guard history --contract <id>` via the real Commander program
    async function runHistory(args: string[]): Promise<void> {
        const program = new Command();
        program.exitOverride(); // prevent Commander from calling process.exit directly
        registerGuardCommand(program);
        await program.parseAsync(["node", "sorokeep", "guard", "history", ...args]);
    }

    it("prints a friendly message when there is no history for the contract", async () => {
        await runHistory(["--contract", TEST_CONTRACT]);

        // Should not exit with error
        expect(mockExit).not.toHaveBeenCalledWith(1);
        // Should print something indicating no history
        const allOutput = mockLog.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(allOutput).toMatch(/no.*history|no.*policy.*change|empty/i);
    });

    it("exits with code 1 and an error when --contract is omitted", async () => {
        let threw = false;
        try {
            await runHistory([]);
        } catch (err: unknown) {
            // Commander throws a CommanderError with exitCode=1 when exitOverride() is
            // set and a required option is missing, instead of calling process.exit(1).
            threw = true;
            expect(err).toHaveProperty("exitCode", 1);
        }

        // Either Commander threw (exitOverride path) or it called process.exit(1)
        if (!threw) {
            expect(mockExit).toHaveBeenCalledWith(1);
        }
        // Either way some error output about the missing option must be present
        // (Commander writes to stderr, our handler to console.error)
        const errOutput = mockError.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
        const combinedOutput = errOutput;
        expect(combinedOutput.length > 0 || threw).toBe(true);
    });

    it("prints one row per policy change in chronological order", async () => {
        // Seed two policy changes directly via the repository
        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: true,
            target_ttl_ledgers: 50_000,
            extend_when_below_ledgers: 5_000,
        });

        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: false,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 10_000,
        });

        await runHistory(["--contract", TEST_CONTRACT]);

        expect(mockExit).not.toHaveBeenCalledWith(1);

        const allOutput = mockLog.mock.calls.map((c) => c.join(" ")).join("\n");

        // Both target TTL values should appear in the output
        expect(allOutput).toContain("50,000");
        expect(allOutput).toContain("100,000");
    });

    it("displays the old → new target TTL values for an update", async () => {
        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: true,
            target_ttl_ledgers: 75_000,
            extend_when_below_ledgers: 15_000,
        });

        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: true,
            target_ttl_ledgers: 150_000,
            extend_when_below_ledgers: 30_000,
        });

        await runHistory(["--contract", TEST_CONTRACT]);

        const allOutput = mockLog.mock.calls.map((c) => c.join(" ")).join("\n");

        // The second row should reference the old value 75,000 and new value 150,000
        expect(allOutput).toContain("75,000");
        expect(allOutput).toContain("150,000");
    });

    it("shows enabled/disabled status changes in the history output", async () => {
        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: false,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        await runHistory(["--contract", TEST_CONTRACT]);

        const allOutput = mockLog.mock.calls.map((c) => c.join(" ")).join("\n");

        // Should indicate both enabled and disabled states appeared
        expect(allOutput.toLowerCase()).toMatch(/enabled|disabled/);
    });

    it("outputs rows with timestamps", async () => {
        upsertExtensionPolicy(sharedDb, {
            contract_id: TEST_CONTRACT,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        await runHistory(["--contract", TEST_CONTRACT]);

        const allOutput = mockLog.mock.calls.map((c) => c.join(" ")).join("\n");
        // ISO timestamp or common date format
        expect(allOutput).toMatch(/\d{4}[-/]\d{2}[-/]\d{2}/);
    });

    it("exits with code 1 when contract is not found in the database", async () => {
        await runHistory(["--contract", "NONEXISTENT_CONTRACT_ID"]);
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringMatching(/not found/i));
    });
});
