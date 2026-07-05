import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { registerCostsCommand } from "../../src/commands/costs.js";
import {
    insertContract,
    upsertEntry,
    recordExtension,
} from "../../src/db/repositories.js";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

vi.mock("../../src/rpc/client.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        StellarRpcClient: class {
            getFeeStats() {
                return Promise.resolve({
                    baseFeeStroops: 100,
                    surgeFeeStroops: 100,
                    surgePricingMultiplier: 1,
                });
            }
        },
    };
});

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

function seedBasicData(db: Database.Database, costXlm = 0.001) {
    insertContract(db, {
        id: CONTRACT_ID,
        name: "test-contract",
        network: "testnet",
    });

    upsertEntry(db, {
        contract_id: CONTRACT_ID,
        entry_key_xdr: "AAAAA",
        entry_type: "instance",
        label: "instance",
        live_until_ledger: 500000,
        last_modified_ledger: 400000,
        discovery_source: "deterministic",
    });

    const entryRow = db
        .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
        .get(CONTRACT_ID) as { id: number };

    recordExtension(db, {
        contract_id: CONTRACT_ID,
        contract_entry_id: entryRow.id,
        old_ttl_ledgers: 10000,
        new_ttl_ledgers: 20000,
        tx_hash: "abc123def456abc123def456abc123de",
        cost_xlm: costXlm,
        mem_bytes: 2048,
        executed_at_ledger: 400001,
    });
}

describe("costs command", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows a forecast section when extension history exists", async () => {
        seedBasicData(mockDb);
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", CONTRACT_ID]);

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).toMatch(/Forecasted Rent/i);
    });

    it("shows the 30/60/90 day windows", async () => {
        seedBasicData(mockDb);
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", CONTRACT_ID]);

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).toMatch(/30-day/i);
        expect(output).toMatch(/60-day/i);
        expect(output).toMatch(/90-day/i);
    });

    it("does not show forecast data when there is no extension history", async () => {

    // ── AC5: No Forecasted Rent when there is no extension history ────────────
    it("does NOT print Forecasted Rent when there are no extensions", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "empty-contract",
            network: "testnet",

        });

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", CONTRACT_ID]);

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).not.toMatch(/Forecasted Rent/i);
    });

    it("prints JSON output when --json is passed", async () => {
        seedBasicData(mockDb);
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync(["node", "sorokeep", "costs", CONTRACT_ID, "--json"]);

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).toContain("\"contract\"");
        expect(output).toContain("\"summary\"");
    });

    it("exits when the period argument is invalid", async () => {
        const program = new Command();
        registerCostsCommand(program);

        await expect(program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID, "--period", "abc",
        ])).rejects.toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("shows a monthly budget warning when the forecast exceeds the budget", async () => {
        seedBasicData(mockDb, 999);
        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--monthly-budget", "0.001",
        ]);

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).toMatch(/budget/i);
    });


});
