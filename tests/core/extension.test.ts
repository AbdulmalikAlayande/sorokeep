import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    getEntriesForContract,
    recordExtension,
    getExtensionHistory,
    setEntryTypePolicy,
} from "../../src/db/repositories.js";

// ─── Mock RPC client ────────────────────────────────────────────────────────

const mockSubmitExtension = vi.fn();
const mockSubmitRestore = vi.fn();
const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();
const mockSimulateExtension = vi.fn();
const mockSimulateRestore = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    return {
        StellarRpcClient: class MockStellarRpcClient {
            constructor() {}
            submitExtension = mockSubmitExtension;
            submitRestore = mockSubmitRestore;
            getEntryTTLs = mockGetEntryTTLs;
            getCurrentLedger = mockGetCurrentLedger;
            simulateExtension = mockSimulateExtension;
            simulateRestore = mockSimulateRestore;
        },
    };
});

// Import after mocking
const { extendEntries, restoreEntries, simulateExtension, simulateRestore, runAutoExtensions } = await import(
    "../../src/core/extension.js"
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedContract(db: Database.Database, overrides?: Partial<{ id: string; network: string; name: string }>) {
    const id = overrides?.id ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    insertContract(db, {
        id,
        name: overrides?.name ?? "Test Contract",
        network: overrides?.network ?? "testnet",
    });

    upsertEntry(db, {
        contract_id: id,
        entry_key_xdr: "instance-key-xdr",
        entry_type: "instance",
        label: "Contract Instance",
        live_until_ledger: 2500000,
        last_modified_ledger: 2400000,
        discovery_source: "deterministic",
    });

    upsertEntry(db, {
        contract_id: id,
        entry_key_xdr: "wasm-key-xdr",
        entry_type: "wasm",
        label: "WASM Code",
        live_until_ledger: 2600000,
        last_modified_ledger: 2400000,
        discovery_source: "deterministic",
    });

    return id;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Core Extension Logic", () => {
    let db: Database.Database;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    afterEach(() => {
        // Restore env vars
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    function setEnv(key: string, value: string) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }

    // =========================================================================
    // 1. extendEntries
    // =========================================================================
    describe("extendEntries", () => {
        it("returns error when contract not found", async () => {
            const result = await extendEntries(
                db, "NONEXISTENT", ["key1"], 100000, "SECRETKEY123",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("returns error when no entries provided", async () => {
            const contractId = seedContract(db);
            const result = await extendEntries(db, contractId, [], 100000, "SECRETKEY123");
            expect(result.success).toBe(false);
            expect(result.error).toBe("No entries to extend");
        });

        it("extends entries and records history on success", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "abc123txhash",
                cpuInsns: 10000,
                memBytes: 1024,
                ledger: 2500100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500100,
                        liveUntilLedgerSeq: 2600100,
                        lastModifiedLedgerSeq: 2500100,
                        remainingTTL: 100000,
                    },
                    {
                        entryKeyXdr: "wasm-key-xdr",
                        latestLedger: 2500100,
                        liveUntilLedgerSeq: 2700100,
                        lastModifiedLedgerSeq: 2500100,
                        remainingTTL: 200000,
                    },
                ],
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.entriesExtended).toBe(2);
            expect(result.txHash).toBe("abc123txhash");
            expect(result.ledger).toBe(2500100);

            // Verify extension history was recorded
            const history = getExtensionHistory(db, contractId);
            expect(history.length).toBe(2);
            expect(history[0]!.tx_hash).toBe("abc123txhash");
            expect(history[0]!.cpu_insns).toBe(10000);
            expect(history[0]!.mem_bytes).toBe(1024);

            // Verify entries were updated with fresh TTLs
            const updatedEntries = getEntriesForContract(db, contractId);
            const instanceEntry = updatedEntries.find(e => e.entry_key_xdr === "instance-key-xdr");
            expect(instanceEntry!.live_until_ledger).toBe(2600100);
        });

        it("returns error on transaction failure", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: false,
                txHash: "failed-tx",
                ledger: 0,
                error: "Transaction send error: Insufficient funds",
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction send error: Insufficient funds");

            // No history should be recorded
            const history = getExtensionHistory(db, contractId);
            expect(history.length).toBe(0);
        });

        it("logs warning and returns error on submitExtension exception", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockRejectedValue(new Error("Network connection lost"));

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Network connection lost");
        });

        it("logs error and returns false on failed txResult", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: false,
                error: "Simulation failed: Invalid footprint key"
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Simulation failed: Invalid footprint key");
        });
        it("propagates feeCharged from the submitted transaction result", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "fee-tx-hash",
                ledger: 2500100,
                feeCharged: 7500,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500100,
                entries: entries.map(e => ({
                    entryKeyXdr: e.entry_key_xdr,
                    latestLedger: 2500100,
                    liveUntilLedgerSeq: 2600100,
                    lastModifiedLedgerSeq: 2500100,
                    remainingTTL: 100000,
                })),
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.feeCharged).toBe(7500);
        });
    });

    // =========================================================================
    // 2. simulateExtension
    // =========================================================================
    describe("simulateExtension", () => {
        it("returns fee estimate on successful simulation", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 50000,
            });

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(50000);
            expect(result.entriesExtended).toBe(1);
        });

        it("returns error on simulation failure", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockRejectedValue(new Error("Entry is archived"));

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry is archived");
        });

        it("returns error when contract not found", async () => {
            const result = await simulateExtension(
                db, "NONEXISTENT", ["key1"], 100000, "GPUBLICKEY",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("delegates simulation to the RPC client and returns estimated fee as minResourceFee", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 12500,
            });

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr", "wasm-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(12500);
            expect(result.entriesExtended).toBe(2);
            expect(mockSimulateExtension).toHaveBeenCalledWith(
                ["instance-key-xdr", "wasm-key-xdr"],
                100000,
                "GPUBLICKEY",
            );
        });
    });

    // =========================================================================
    // 3. restoreEntries
    // =========================================================================
    describe("restoreEntries", () => {
        it("returns error when contract not found", async () => {
            const result = await restoreEntries(
                db, "NONEXISTENT", ["key1"], "SECRETKEY123",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("returns error when no entries provided", async () => {
            const contractId = seedContract(db);
            const result = await restoreEntries(db, contractId, [], "SECRETKEY123");
            expect(result.success).toBe(false);
            expect(result.error).toBe("No entries to restore");
        });

        it("restores entries and updates DB on success", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: true,
                txHash: "restore-tx-hash",
                ledger: 2500200,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500200,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500200,
                        liveUntilLedgerSeq: 2600200,
                        lastModifiedLedgerSeq: 2500200,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.entriesRestored).toBe(1);
            expect(result.txHash).toBe("restore-tx-hash");
            expect(result.ledger).toBe(2500200);

            // Verify entry was updated
            const updatedEntries = getEntriesForContract(db, contractId);
            const instanceEntry = updatedEntries.find(e => e.entry_key_xdr === "instance-key-xdr");
            expect(instanceEntry!.live_until_ledger).toBe(2600200);
        });

        it("returns error on restore transaction failure", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: false,
                txHash: "failed-restore",
                ledger: 0,
                error: "Entry not found in archive",
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry not found in archive");
        });

        it("extracts resource fee and status parameters from response", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: true,
                txHash: "restore-with-resources",
                ledger: 2500300,
                cpuInsns: 8500,
                memBytes: 2048,
                minResourceFee: 75000,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500300,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500300,
                        liveUntilLedgerSeq: 2600300,
                        lastModifiedLedgerSeq: 2500300,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.cpuInsns).toBe(8500);
            expect(result.memBytes).toBe(2048);
            expect(result.minResourceFee).toBe(75000);
            expect(result.txHash).toBe("restore-with-resources");
            expect(result.ledger).toBe(2500300);
        });
    });

    // =========================================================================
    // 4. simulateRestore
    // =========================================================================
    describe("simulateRestore", () => {
        it("returns fee estimate on successful simulation", async () => {
            const contractId = seedContract(db);

            mockSimulateRestore.mockResolvedValue({
                success: true,
                minResourceFee: 65000,
            });

            const result = await simulateRestore(
                db, contractId, ["instance-key-xdr"], "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(65000);
            expect(result.entriesRestored).toBe(1);
        });

        it("returns error on simulation failure", async () => {
            const contractId = seedContract(db);

            mockSimulateRestore.mockResolvedValue({
                success: false,
                minResourceFee: 0,
                error: "Entry not found in archive",
            });

            const result = await simulateRestore(
                db, contractId, ["instance-key-xdr"], "GPUBLICKEY",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry not found in archive");
        });

        it("returns error when contract not found", async () => {
            const result = await simulateRestore(
                db, "NONEXISTENT", ["key1"], "GPUBLICKEY",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });
    });

    // =========================================================================
    // 4. runAutoExtensions
    // =========================================================================
    describe("runAutoExtensions", () => {
        it("skips contracts without extension policies", async () => {
            seedContract(db);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(0);
            expect(result.contractsExtended).toBe(0);
        });

        it("skips contracts with disabled policies", async () => {
            const contractId = seedContract(db);
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: false,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(0);
        });

        it("extends entries below threshold when policy is enabled", async () => {
            const contractId = seedContract(db);

            // Set instance entry with low TTL (remaining = 10000 when latest ledger = 2400000)
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "auto-ext-tx",
                ledger: 2400100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2500100,
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(1);
            expect(result.entriesExtended).toBeGreaterThanOrEqual(1);
            expect(result.extensions[0]!.txHash).toBe("auto-ext-tx");
        });

        it("does not extend entries above threshold", async () => {
            const contractId = seedContract(db);

            // Entries have high TTL (remaining = 100000, above 20000 threshold)
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 200000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            // Entries have TTL ~100000 and ~200000, both above 20000 — no extension needed
            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
        });

        it("reports error when keypair cannot be resolved", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:NONEXISTENT_VAR_12345",
            });

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(0);
            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain("Cannot resolve keypair");
        });

        it("filters by network", async () => {
            seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS3", network: "mainnet" });

            upsertExtensionPolicy(db, {
                contract_id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS3",
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
            });

            const result = await runAutoExtensions(db, "testnet");

            // Should not process mainnet contracts when running for testnet
            expect(result.contractsChecked).toBe(0);
        });

        it("collects errors without aborting for individual contract failures", async () => {
            const id1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS1";
            const id2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS2";

            seedContract(db, { id: id1 });
            seedContract(db, { id: id2 });

            // Both with low TTL entries
            for (const id of [id1, id2]) {
                upsertEntry(db, {
                    contract_id: id,
                    entry_key_xdr: `instance-${id}`,
                    entry_type: "instance",
                    live_until_ledger: 2410000,
                    discovery_source: "deterministic",
                });
                upsertExtensionPolicy(db, {
                    contract_id: id,
                    enabled: true,
                    target_ttl_ledgers: 100000,
                    extend_when_below_ledgers: 20000,
                    keypair_source: "env:TEST_SECRET_KEY",
                });
            }

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            // First contract succeeds, second fails
            let callCount = 0;
            mockSubmitExtension.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { success: true, txHash: "tx1", ledger: 2400100 };
                }
                return { success: false, txHash: "tx2", ledger: 0, error: "Insufficient funds" };
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: `instance-${id1}`,
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(2);
            // At least one should have been checked, and we should have errors
            expect(result.errors.length).toBeGreaterThanOrEqual(1);
        });

        it("records an error when extension succeeds but txHash or ledger is missing", async () => {
            const contractId = seedContract(db);

            // Set instance entry with low TTL so it triggers extension
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            // Extension succeeds but txHash and ledger are missing
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: null,
                ledger: null,
                entriesExtended: 1,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2500100,
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await runAutoExtensions(db, "testnet");

            // No extension should be pushed to result.extensions
            expect(result.extensions).toHaveLength(0);

            // An error should be recorded about missing txHash or ledger
            expect(result.errors).not.toHaveLength(0);
            expect(result.errors[0]).toContain(contractId);
        });

        it("flags anomalous execution if resource usage spikes", async () => {
            const contractId = seedContract(db);

            // Seed with some normal history
            recordExtension(db, {
                contract_id: contractId, contract_entry_id: 1, old_ttl_ledgers: 1, new_ttl_ledgers: 2,
                tx_hash: "h1", cost_xlm: 0.1, executed_at_ledger: 1, cpu_insns: 1000, mem_bytes: 100
            });
            recordExtension(db, {
                contract_id: contractId, contract_entry_id: 1, old_ttl_ledgers: 1, new_ttl_ledgers: 2,
                tx_hash: "h2", cost_xlm: 0.1, executed_at_ledger: 2, cpu_insns: 1200, mem_bytes: 120
            });

            // Set instance entry with low TTL
            upsertEntry(db, {
                contract_id: contractId, entry_key_xdr: "instance-key-xdr", entry_type: "instance",
                live_until_ledger: 2410000,
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId, enabled: true, target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000, keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            // This extension will have a huge resource spike (3x CPU, 4x MEM)
            mockSubmitExtension.mockResolvedValue({
                success: true, txHash: "anomaly-tx", ledger: 2400100,
                cpuInsns: 3301, // > 3 * 1100
                memBytes: 441, // > 4 * 110
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr", latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100, remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.isAnomaly).toBe(true);
            expect(result.extensions[0]!.anomalyDetails).toContain("CPU usage is 3.00x baseline");
            expect(result.extensions[0]!.anomalyDetails).toContain("Memory usage is 4.01x baseline");

            // Verify the new extension was recorded with anomaly flag
            const history = getExtensionHistory(db, contractId);
            const anomaly = history.find(h => h.tx_hash === "anomaly-tx");
            expect(anomaly!.is_anomaly).toBe(1);
        });
    });

    describe("runAutoExtensions — per-entry-type policy resolution", () => {
        it("uses instance override for instance entries", async () => {
            const contractId = seedContract(db);

            // Set contract default: target=1000
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set instance override: target=2000
            setEntryTypePolicy(db, contractId, "instance", {
                target_ttl_ledgers: 2000,
                extend_when_below_ledgers: 300,
            });

            // Instance entry with low TTL
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2400500, // remaining = 500, below 300 threshold
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "instance-override-tx",
                ledger: 2400100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2502100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 2000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            // Should have extended with instance override target (2000)
            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.txHash).toBe("instance-override-tx");

            // Verify entry was extended to the override target
            const updatedEntries = getEntriesForContract(db, contractId);
            const instanceEntry = updatedEntries.find(e => e.entry_key_xdr === "instance-key-xdr");
            expect(instanceEntry?.live_until_ledger).toBe(2502100);
        });

        it("uses persistent override for persistent entries", async () => {
            const contractId = seedContract(db);

            // Set contract default: target=1000
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set persistent override: target=500
            setEntryTypePolicy(db, contractId, "persistent", {
                target_ttl_ledgers: 500,
                extend_when_below_ledgers: 50,
            });

            // Persistent entry with low TTL
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "persistent-key-xdr",
                entry_type: "persistent",
                live_until_ledger: 2400075, // remaining = 75, below 50 threshold
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "persistent-override-tx",
                ledger: 2400100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "persistent-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2400600,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 500,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.txHash).toBe("persistent-override-tx");
        });

        it("falls back to contract default for entry types without override", async () => {
            const contractId = seedContract(db);

            // Set contract default: target=1000
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set instance override ONLY
            setEntryTypePolicy(db, contractId, "instance", {
                target_ttl_ledgers: 2000,
                extend_when_below_ledgers: 300,
            });

            // Add a wasm entry (no override, should use contract default)
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "wasm-key-xdr",
                entry_type: "wasm",
                live_until_ledger: 2400050, // remaining = 50, below 100 threshold
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "wasm-default-tx",
                ledger: 2400100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "wasm-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2401100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 1000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            // Wasm should be extended to contract default (1000), not instance override (2000)
            expect(result.extensions[0]!.txHash).toBe("wasm-default-tx");
        });

        it("does not extend entry when type override says extend_when_below is not met", async () => {
            const contractId = seedContract(db);

            // Set contract default
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set persistent override with HIGH threshold (1000)
            setEntryTypePolicy(db, contractId, "persistent", {
                target_ttl_ledgers: 500,
                extend_when_below_ledgers: 1000,
            });

            // Persistent entry with TTL above override threshold
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "persistent-key-xdr",
                entry_type: "persistent",
                live_until_ledger: 2401500, // remaining = 1500, NOT below 1000 threshold
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            // Should NOT extend because TTL is above override threshold
            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
        });

        it("rate limiting applies per-contract not per-policy-row", async () => {
            const contractId = seedContract(db);

            // Set contract default
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set type overrides for both instance and wasm
            setEntryTypePolicy(db, contractId, "instance", {
                target_ttl_ledgers: 2000,
                extend_when_below_ledgers: 300,
            });
            setEntryTypePolicy(db, contractId, "wasm", {
                target_ttl_ledgers: 3000,
                extend_when_below_ledgers: 400,
            });

            // Add both entry types with low TTLs
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2400200,
            });
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "wasm-key-xdr",
                entry_type: "wasm",
                live_until_ledger: 2400200,
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            // Mock rate limit: simulate 5 extensions already made in last hour
            db.prepare(`
                INSERT INTO extension_history (
                    contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                    tx_hash, executed_at_ledger, executed_at
                ) VALUES
                (?, 1, 100, 1000, 'h1', 100, datetime('now', '-30 minutes')),
                (?, 1, 100, 1000, 'h2', 100, datetime('now', '-30 minutes')),
                (?, 1, 100, 1000, 'h3', 100, datetime('now', '-30 minutes')),
                (?, 1, 100, 1000, 'h4', 100, datetime('now', '-30 minutes')),
                (?, 1, 100, 1000, 'h5', 100, datetime('now', '-30 minutes'))
            `).run(contractId, contractId, contractId, contractId, contractId);

            const result = await runAutoExtensions(db, "testnet");

            // Rate limit should block ALL entries for this contract, not just one type
            expect(result.contractsExtended).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("rate limit");
            expect(mockSubmitExtension).not.toHaveBeenCalled();
        });

        it("instance and wasm entries with different overrides both extended correctly", async () => {
            const contractId = seedContract(db);

            // Set contract default
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 1000,
                extend_when_below_ledgers: 100,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            // Set instance override: target=2000
            setEntryTypePolicy(db, contractId, "instance", {
                target_ttl_ledgers: 2000,
                extend_when_below_ledgers: 300,
            });

            // Set wasm override: target=3000
            setEntryTypePolicy(db, contractId, "wasm", {
                target_ttl_ledgers: 3000,
                extend_when_below_ledgers: 400,
            });

            // Update entries to be below their respective overrides
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2400200, // below 300
            });
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "wasm-key-xdr",
                entry_type: "wasm",
                live_until_ledger: 2400350, // below 400
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            let callCount = 0;
            mockSubmitExtension.mockImplementation(async (keys: string[]) => {
                callCount++;
                return {
                    success: true,
                    txHash: `tx-${callCount}`,
                    ledger: 2400100,
                };
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2402100, // extended to 2000 from 2400100
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 2000,
                    },
                    {
                        entryKeyXdr: "wasm-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2403100, // extended to 3000 from 2400100
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 3000,
                    },
                ],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.entriesExtended).toBe(2);

            // Verify entries were extended to their respective override targets
            const entries = getEntriesForContract(db, contractId);
            const instanceEntry = entries.find(e => e.entry_key_xdr === "instance-key-xdr");
            const wasmEntry = entries.find(e => e.entry_key_xdr === "wasm-key-xdr");

            expect(instanceEntry?.live_until_ledger).toBe(2402100);
            expect(wasmEntry?.live_until_ledger).toBe(2403100);
        });
    });
});

