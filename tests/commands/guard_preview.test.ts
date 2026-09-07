import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerGuardCommand } from "../../src/commands/guard";
import {
    insertContract,
    upsertExtensionPolicy,
    upsertEntry,
    updateLastCheckedLedger,
} from "../../src/db/repositories";

let mockDb: Database.Database;
const mockRpcCall = vi.fn(() => {
    throw new Error("RPC call attempted! guard preview must make no RPC calls.");
});

vi.mock("../../src/rpc/client.js", () => {
    return {
        StellarRpcClient: class {
            constructor() {
                mockRpcCall();
            }
        },
    };
});

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function parseAsync(args: string[]): Promise<void> {
    const program = new Command();
    registerGuardCommand(program);
    await program.parseAsync(["node", "sorokeep", ...args]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("guard preview command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        mockRpcCall.mockClear();

        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("flags an entry with cached TTL below the policy threshold as 'would extend'", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 25000, // remaining: 25000 - 10000 = 15000 < 20000 => would extend
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_WASM",
            entry_type: "wasm",
            label: "WASM Code",
            live_until_ledger: 50000, // remaining: 50000 - 10000 = 40000 >= 20000 => ok
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("would extend"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("ok"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("guard preview makes no RPC calls", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 25000,
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("shows 'ok' when all entries are above the policy threshold", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 50000, // remaining: 40000 >= 20000 => ok
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("ok"));
        expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("would extend"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("respects boundary condition: remaining == threshold is 'ok', remaining == threshold - 1 is 'would extend'", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        // remaining = 30000 - 10000 = 20000 (equal to threshold => should NOT extend)
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_BOUNDARY_EQUAL",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 30000,
        });

        // remaining = 29999 - 10000 = 19999 (below threshold => should extend)
        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_BOUNDARY_BELOW",
            entry_type: "wasm",
            label: "WASM Code",
            live_until_ledger: 29999,
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("would extend"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("ok"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("shows 'expired' instead of 'would extend' when remaining TTL is negative", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_EXPIRED",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 5000, // remaining: 5000 - 10000 = -5000 (< 0 => expired)
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("expired"));
        expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("would extend"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("shows 'DISABLED' in policy summary when auto-extension is disabled", async () => {
        updateLastCheckedLedger(mockDb, contractID, 10000);

        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: false,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 25000,
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("DISABLED"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("shows 'unknown' when live_until_ledger or last_checked_ledger is null", async () => {
        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        upsertEntry(mockDb, {
            contract_id: contractID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("exits with 1 when the contract is not registered", async () => {
        await expect(
            parseAsync(["guard", "preview", "--contract", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"])
        ).rejects.toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("prints message when no extension policy is configured", async () => {
        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("No extension policy configured"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("prints message when no entries are tracked for the contract", async () => {
        upsertExtensionPolicy(mockDb, {
            contract_id: contractID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
        });

        await parseAsync(["guard", "preview", "--contract", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("No entries tracked for this contract"));
        expect(mockRpcCall).not.toHaveBeenCalled();
    });
});
