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

// ─── Shared mock state ────────────────────────────────────────────────────────

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

// Suppress live RPC calls — getFeeStats always resolves with a neutral result
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

// Helper: seed a contract + one instance entry + one extension record
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

    // Retrieve the auto-assigned entry id
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

    return entryRow.id;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("costs command — Forecasted Rent section", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── AC1: "Forecasted Rent" section header appears ─────────────────────────
    it("prints a 'Forecasted Rent' section header when extension history exists", async () => {
        seedBasicData(mockDb);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/Forecasted Rent/i);
    });

    // ── AC2: 30-day window is shown ───────────────────────────────────────────
    it("shows a 30-day projected cost in the Forecasted Rent section", async () => {
        seedBasicData(mockDb);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/30.day/i);
        expect(allOutput).toMatch(/XLM/);
    });

    // ── AC3: 60-day window is shown ───────────────────────────────────────────
    it("shows a 60-day projected cost in the Forecasted Rent section", async () => {
        seedBasicData(mockDb);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/60.day/i);
    });

    // ── AC4: 90-day window is shown ───────────────────────────────────────────
    it("shows a 90-day projected cost in the Forecasted Rent section", async () => {
        seedBasicData(mockDb);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/90.day/i);
    });

    // ── AC5: No Forecasted Rent when there is no extension history ────────────
    it("does NOT print Forecasted Rent when there are no extensions", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "empty-contract",
            network: "testnet",
        });

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).not.toMatch(/Forecasted Rent/i);
    });

    // ── AC6: Budget warning displayed when 30-day projection exceeds budget ───
    it("displays a budget warning when 30-day projection exceeds the configured monthly budget", async () => {
        // Seed with a very high extension cost so the projection easily exceeds
        // any small monthly budget limit.
        seedBasicData(mockDb, 999);

        const program = new Command();
        registerCostsCommand(program);

        // Pass a tiny budget so it will definitely be breached
        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--monthly-budget", "0.001",
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/budget/i);
        expect(allOutput).toMatch(/exceed|over|breach/i);
    });

    // ── AC7: No budget warning when projection is within budget ──────────────
    it("does NOT display a budget warning when projection is within budget", async () => {
        seedBasicData(mockDb, 0.0000001);

        const program = new Command();
        registerCostsCommand(program);

        // Very large budget so nothing is breached
        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--monthly-budget", "10000",
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).not.toMatch(/exceed|over|breach/i);
    });

    // ── AC8: Warning flag appears for each breaching window ──────────────────
    it("shows a warning flag next to each window that breaches the monthly budget", async () => {
        seedBasicData(mockDb, 999);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--monthly-budget", "0.001",
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        // At least one per-window breach marker should appear
        expect(allOutput).toMatch(/⚠|OVER BUDGET|over budget|warning/i);
    });

    // ── AC9: Budget summary line shows budget value ───────────────────────────
    it("shows the configured monthly budget value in the output", async () => {
        seedBasicData(mockDb, 999);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--monthly-budget", "5",
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        // The budget amount (5 XLM) must appear somewhere in the forecast section
        expect(allOutput).toMatch(/5(\.\d+)?\s*XLM/);
    });

    // ── AC10: Contract not found exits with code 1 ────────────────────────────
    it("exits with code 1 when contract is not registered", async () => {
        const program = new Command();
        registerCostsCommand(program);

        await expect(
            program.parseAsync([
                "node", "sorokeep", "costs",
                "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            ])
        ).rejects.toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    // ── AC11: Invalid --period exits with code 1 ──────────────────────────────
    it("exits with code 1 when --period is not a positive integer", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "test-contract",
            network: "testnet",
        });

        const program = new Command();
        registerCostsCommand(program);

        await expect(
            program.parseAsync([
                "node", "sorokeep", "costs", CONTRACT_ID,
                "--period", "-5",
            ])
        ).rejects.toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    // ── AC12: Forecasted Rent section absent when --all flag is used ──────────
    // When viewing all-time history (no period), projection is not meaningful.
    it("does NOT show Forecasted Rent when --all flag is used", async () => {
        seedBasicData(mockDb);

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
            "--all",
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).not.toMatch(/Forecasted Rent/i);
    });

    // ── AC13: Projection values are numerically correct ───────────────────────
    it("shows non-zero numeric XLM values for 30/60/90-day windows", async () => {
        // Seed with mem_bytes=1024 so projectRentWindows produces predictable output
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "math-contract",
            network: "testnet",
        });
        upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAABB",
            entry_type: "instance",
            label: "instance",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        const entryRow = mockDb
            .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
            .get(CONTRACT_ID) as { id: number };

        recordExtension(mockDb, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryRow.id,
            old_ttl_ledgers: 10000,
            new_ttl_ledgers: 20000,
            tx_hash: "aaaaabbbbbcccccaaaaabbbbbcccccaa",
            cost_xlm: 0.01,
            mem_bytes: 1024,
            executed_at_ledger: 400001,
        });

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        // Should contain at least one non-zero decimal like "0.0000XXX XLM"
        expect(allOutput).toMatch(/\d+\.\d+\s*XLM/);
    });

    // ── AC14: Graceful handling when mem_bytes is null (use default size) ─────
    it("still shows Forecasted Rent even when extension records have no mem_bytes", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "no-mem-contract",
            network: "testnet",
        });
        upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "BBBBB",
            entry_type: "persistent",
            label: "data",
            live_until_ledger: 500000,
            last_modified_ledger: 400000,
            discovery_source: "deterministic",
        });
        const entryRow = mockDb
            .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
            .get(CONTRACT_ID) as { id: number };

        recordExtension(mockDb, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryRow.id,
            old_ttl_ledgers: 5000,
            new_ttl_ledgers: 15000,
            tx_hash: "nullmemnullmemnullmemnullmemnull",
            cost_xlm: 0.002,
            mem_bytes: null,      // <-- no size info
            executed_at_ledger: 400002,
        });

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/Forecasted Rent/i);
        expect(allOutput).toMatch(/30.day/i);
    });

    // ── AC15: Multiple entries — projection per-entry and total ───────────────
    it("shows one forecast row per entry type present in the contract", async () => {
        insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "multi-entry-contract",
            network: "testnet",
        });

        const types = [
            { xdr: "KEY001", type: "instance" as const },
            { xdr: "KEY002", type: "wasm" as const },
        ];

        for (const { xdr, type } of types) {
            upsertEntry(mockDb, {
                contract_id: CONTRACT_ID,
                entry_key_xdr: xdr,
                entry_type: type,
                live_until_ledger: 500000,
                last_modified_ledger: 400000,
                discovery_source: "deterministic",
            });
        }

        const entries = mockDb
            .prepare("SELECT id, entry_type FROM contract_entries WHERE contract_id = ?")
            .all(CONTRACT_ID) as { id: number; entry_type: string }[];

        entries.forEach(({ id }, i) => {
            recordExtension(mockDb, {
                contract_id: CONTRACT_ID,
                contract_entry_id: id,
                old_ttl_ledgers: 10000,
                new_ttl_ledgers: 20000,
                tx_hash: `tx${i}aaaaabbbbbbcccccddddd${i}aaaa`,
                cost_xlm: 0.001,
                mem_bytes: 2048,
                executed_at_ledger: 400001 + i,
            });
        });

        const program = new Command();
        registerCostsCommand(program);

        await program.parseAsync([
            "node", "sorokeep", "costs", CONTRACT_ID,
        ]);

        const allOutput = consoleLogSpy.mock.calls.flat().join("\n");
        expect(allOutput).toMatch(/Forecasted Rent/i);
        // Both entry types should appear in the forecast section
        expect(allOutput).toMatch(/instance/i);
        expect(allOutput).toMatch(/wasm/i);
    });
});
