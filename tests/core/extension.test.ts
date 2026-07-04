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
} from "../../src/db/repositories.js";

// ─── Mock RPC client ────────────────────────────────────────────────────────

const mockSubmitExtension = vi.fn();
const mockSubmitRestore = vi.fn();
const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();
const mockSimulateExtension = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    return {
        StellarRpcClient: class MockStellarRpcClient {
            constructor() {}
            submitExtension = mockSubmitExtension;
            submitRestore = mockSubmitRestore;
            getEntryTTLs = mockGetEntryTTLs;
            getCurrentLedger = mockGetCurrentLedger;
            simulateExtension = mockSimulateExtension;
        },
    };
});

// Import after mocking
const { extendEntries, restoreEntries, simulateExtension, runAutoExtensions } = await import(
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
                error: "Insufficient funds",
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Insufficient funds");

            // No history should be recorded
            const history = getExtensionHistory(db, contractId);
            expect(history.length).toBe(0);
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

            mockSimulateExtension.mockResolvedValue({
                success: false,
                minResourceFee: 0,
                error: "Entry is archived",
            });

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
});
