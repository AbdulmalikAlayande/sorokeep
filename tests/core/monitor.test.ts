import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    insertAlertConfig,
    getAlertConfigsForContract,
    hasUnresolvedAlert,
} from "../../src/db/repositories.js";
import {getDatabaseForTesting} from "../../src/db/database";
import {MonitorCycleResult, runMonitorCycle} from "../../src/core/monitor";


const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getEntryTTLs = mockGetEntryTTLs;
        getCurrentLedger = mockGetCurrentLedger;
        getNetwork = vi.fn().mockReturnValue("testnet");
    }
    return {
        StellarRpcClient: MockStellarRpcClient,
    };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedContract(
    db: Database.Database,
    contractId: string,
    network: string,
    entries: Array<{ keyXdr: string; type: string; liveUntil: number }>
) {
    insertContract(db, { id: contractId, network });
    for (const entry of entries) {
        upsertEntry(db, {
            contract_id: contractId,
            entry_key_xdr: entry.keyXdr,
            entry_type: entry.type,
            live_until_ledger: entry.liveUntil,
            discovery_source: "deterministic",
        });
    }
}

function addWebhookAlert(
    db: Database.Database,
    contractId: string,
    thresholdLedgers: number,
    target = "https://example.com/hook"
) {
    insertAlertConfig(db, {
        contract_id: contractId,
        channel_type: "webhook",
        channel_target: target,
        threshold_ledgers: thresholdLedgers,
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runMonitorCycle", () => {
    let db: Database.Database;
    const LEDGER = 2_500_000;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetCurrentLedger.mockResolvedValue(LEDGER);
    });

    // =========================================================================
    // 1. RETURN SHAPE
    // =========================================================================
    describe("Return shape", () => {
        it("returns a well-formed MonitorCycleResult with all required fields", async () => {
            const result: MonitorCycleResult = await runMonitorCycle(db, "testnet");

            expect(result).toHaveProperty("contractsChecked");
            expect(result).toHaveProperty("entriesUpdated");
            expect(result).toHaveProperty("thresholdsCrossed");
            expect(result).toHaveProperty("alertsResolved");
            expect(result).toHaveProperty("errors");
            expect(result).toHaveProperty("cycleStartedAt");
            expect(result).toHaveProperty("cycleFinishedAt");
            expect(Array.isArray(result.errors)).toBe(true);
            expect(result.cycleStartedAt).toBeInstanceOf(Date);
            expect(result.cycleFinishedAt).toBeInstanceOf(Date);
        });

        it("cycleFinishedAt is after or equal to cycleStartedAt", async () => {
            const result = await runMonitorCycle(db, "testnet");
            expect(result.cycleFinishedAt.getTime()).toBeGreaterThanOrEqual(
                result.cycleStartedAt.getTime()
            );
        });
    });

    // =========================================================================
    // 2. BASIC CYCLE BEHAVIOUR
    // =========================================================================
    describe("Basic cycle behaviour", () => {
        it("does nothing when no contracts are registered", async () => {
            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(0);
            expect(result.entriesUpdated).toBe(0);
            expect(result.thresholdsCrossed).toBe(0);
            expect(mockGetEntryTTLs).not.toHaveBeenCalled();
        });

        it("skips contracts on a different network", async () => {
            seedContract(db, "MAINNET_CONTRACT", "mainnet", [
                { keyXdr: "mainnet-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(0);
            expect(mockGetEntryTTLs).not.toHaveBeenCalled();
        });

        it("only processes contracts on the target network, ignoring others", async () => {
            seedContract(db, "TESTNET_C", "testnet", [
                { keyXdr: "t-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);
            seedContract(db, "MAINNET_C", "mainnet", [
                { keyXdr: "m-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "t-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(1);
            expect(mockGetEntryTTLs).toHaveBeenCalledTimes(1);
        });

        it("makes one batched RPC call per contract, not one per entry", async () => {
            seedContract(db, "CONTRACT_A", "testnet", [
                { keyXdr: "a-instance", type: "instance", liveUntil: LEDGER + 50000 },
                { keyXdr: "a-wasm",     type: "wasm",     liveUntil: LEDGER + 80000 },
                { keyXdr: "a-storage",  type: "persistent", liveUntil: LEDGER + 30000 },
            ]);
            seedContract(db, "CONTRACT_B", "testnet", [
                { keyXdr: "b-instance", type: "instance", liveUntil: LEDGER + 20000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

            await runMonitorCycle(db, "testnet");

            // Two contracts → exactly two RPC calls
            expect(mockGetEntryTTLs).toHaveBeenCalledTimes(2);
        });

        it("passes all known entry keys for a contract in a single RPC call", async () => {
            seedContract(db, "CONTRACT_MULTI", "testnet", [
                { keyXdr: "key-1", type: "instance",  liveUntil: LEDGER + 50000 },
                { keyXdr: "key-2", type: "wasm",      liveUntil: LEDGER + 80000 },
                { keyXdr: "key-3", type: "persistent", liveUntil: LEDGER + 20000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

            await runMonitorCycle(db, "testnet");

            const callArgs = mockGetEntryTTLs.mock.calls[0]![0] as string[];
            expect(callArgs).toHaveLength(3);
            expect(callArgs).toContain("key-1");
            expect(callArgs).toContain("key-2");
            expect(callArgs).toContain("key-3");
        });

        it("refreshes TTLs in the DB for all returned entries", async () => {
            seedContract(db, "CONTRACT_REFRESH", "testnet", [
                { keyXdr: "r-instance", type: "instance", liveUntil: LEDGER + 50000 },
                { keyXdr: "r-wasm",     type: "wasm",     liveUntil: LEDGER + 80000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "r-instance", liveUntilLedgerSeq: LEDGER + 45000, lastModifiedLedgerSeq: LEDGER - 100, remainingTTL: 45000 },
                    { entryKeyXdr: "r-wasm",     liveUntilLedgerSeq: LEDGER + 75000, lastModifiedLedgerSeq: LEDGER - 200, remainingTTL: 75000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");

            expect(result.entriesUpdated).toBe(2);

            const entries = getEntriesForContract(db, "CONTRACT_REFRESH");
            expect(entries.find(e => e.entry_key_xdr === "r-instance")!.live_until_ledger).toBe(LEDGER + 45000);
            expect(entries.find(e => e.entry_key_xdr === "r-wasm")!.live_until_ledger).toBe(LEDGER + 75000);
        });

        it("updates last_checked_ledger on the contract after a successful cycle", async () => {
            seedContract(db, "CONTRACT_LEDGER", "testnet", [
                { keyXdr: "l-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "l-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 5, remainingTTL: 48000 },
                ],
            });

            await runMonitorCycle(db, "testnet");

            const { getContract } = await import("../../src/db/repositories.js");
            const contract = getContract(db, "CONTRACT_LEDGER");
            expect(contract!.last_checked_ledger).toBe(LEDGER);
        });

        it("does not update entry TTL when RPC returns no matching entry for that key", async () => {
            seedContract(db, "CONTRACT_ARCHIVED", "testnet", [
                { keyXdr: "archived-key", type: "instance", liveUntil: LEDGER + 1000 },
            ]);

            // RPC returns empty — entry may be archived
            mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(1);

            // TTL must remain unchanged — never zero out on empty response
            const entries = getEntriesForContract(db, "CONTRACT_ARCHIVED");
            expect(entries[0]!.live_until_ledger).toBe(LEDGER + 1000);
        });

        it("counts multiple contracts correctly across the cycle", async () => {
            seedContract(db, "C1", "testnet", [{ keyXdr: "k1", type: "instance", liveUntil: LEDGER + 50000 }]);
            seedContract(db, "C2", "testnet", [{ keyXdr: "k2", type: "instance", liveUntil: LEDGER + 50000 }]);
            seedContract(db, "C3", "testnet", [{ keyXdr: "k3", type: "instance", liveUntil: LEDGER + 50000 }]);

            mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.contractsChecked).toBe(3);
        });
    });

    // =========================================================================
    // 3. THRESHOLD DETECTION
    // =========================================================================
    describe("Threshold detection", () => {
        it("detects when an entry TTL drops below an alert threshold", async () => {
            seedContract(db, "CONTRACT_ALERT", "testnet", [
                { keyXdr: "alert-key", type: "instance", liveUntil: LEDGER + 20000 },
            ]);
            addWebhookAlert(db, "CONTRACT_ALERT", 15000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "alert-key", liveUntilLedgerSeq: LEDGER + 8000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 8000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");

            expect(result.thresholdsCrossed).toBe(1);

            const configs = getAlertConfigsForContract(db, "CONTRACT_ALERT");
            const entries = getEntriesForContract(db, "CONTRACT_ALERT");
            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(true);
        });

        it("does NOT fire an alert when TTL is still above the threshold", async () => {
            seedContract(db, "CONTRACT_SAFE", "testnet", [
                { keyXdr: "safe-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);
            addWebhookAlert(db, "CONTRACT_SAFE", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "safe-key", liveUntilLedgerSeq: LEDGER + 50000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 50000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(0);
        });

        it("does NOT fire an alert when TTL equals threshold exactly (boundary: strictly less than)", async () => {
            seedContract(db, "CONTRACT_BOUNDARY", "testnet", [
                { keyXdr: "b-key", type: "instance", liveUntil: LEDGER + 10000 },
            ]);
            addWebhookAlert(db, "CONTRACT_BOUNDARY", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "b-key", liveUntilLedgerSeq: LEDGER + 10000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 10000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(0);
        });

        it("fires when TTL is exactly one ledger below threshold", async () => {
            seedContract(db, "CONTRACT_NEAR", "testnet", [
                { keyXdr: "near-key", type: "instance", liveUntil: LEDGER + 9999 },
            ]);
            addWebhookAlert(db, "CONTRACT_NEAR", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "near-key", liveUntilLedgerSeq: LEDGER + 9999, lastModifiedLedgerSeq: LEDGER, remainingTTL: 9999 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(1);
        });

        it("fires for each *distinct* alert config that is crossed for the same entry", async () => {
            seedContract(db, "CONTRACT_MULTI_ALERT", "testnet", [
                { keyXdr: "ma-key", type: "instance", liveUntil: LEDGER + 20000 },
            ]);
            // Two separate alert configs at different thresholds
            addWebhookAlert(db, "CONTRACT_MULTI_ALERT", 15000, "https://hook1.example.com");
            addWebhookAlert(db, "CONTRACT_MULTI_ALERT", 12000, "https://hook2.example.com");

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "ma-key", liveUntilLedgerSeq: LEDGER + 8000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 8000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            // Both thresholds were crossed
            expect(result.thresholdsCrossed).toBe(2);
        });

        it("fires for each entry independently when multiple entries cross thresholds", async () => {
            seedContract(db, "CONTRACT_ENTRIES_ALERT", "testnet", [
                { keyXdr: "e-instance", type: "instance",   liveUntil: LEDGER + 5000 },
                { keyXdr: "e-wasm",     type: "wasm",       liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_ENTRIES_ALERT", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "e-instance", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 },
                    { entryKeyXdr: "e-wasm",     liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(2);
        });

        it("does NOT fire alert when a contract has no alert configs configured", async () => {
            seedContract(db, "CONTRACT_NO_ALERTS", "testnet", [
                { keyXdr: "na-key", type: "instance", liveUntil: LEDGER + 100 },
            ]);
            // No insertAlertConfig call

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "na-key", liveUntilLedgerSeq: LEDGER + 100, lastModifiedLedgerSeq: LEDGER, remainingTTL: 100 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(0);
        });

        it("fires alert even when TTL is expired (remainingTTL <= 0)", async () => {
            seedContract(db, "CONTRACT_EXPIRED", "testnet", [
                { keyXdr: "exp-key", type: "instance", liveUntil: LEDGER - 1000 },
            ]);
            addWebhookAlert(db, "CONTRACT_EXPIRED", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "exp-key", liveUntilLedgerSeq: LEDGER - 1000, lastModifiedLedgerSeq: LEDGER, remainingTTL: -1000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 4. DEDUPLICATION — no re-fire of existing unresolved alerts
    // =========================================================================
    describe("Alert deduplication", () => {
        it("does not re-fire an alert that is already unresolved", async () => {
            seedContract(db, "CONTRACT_DEDUP", "testnet", [
                { keyXdr: "dedup-key", type: "instance", liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_DEDUP", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "dedup-key", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 },
                ],
            });

            const result1 = await runMonitorCycle(db, "testnet");
            expect(result1.thresholdsCrossed).toBe(1);

            const result2 = await runMonitorCycle(db, "testnet");
            expect(result2.thresholdsCrossed).toBe(0);
        });

        it("does not double-fire across three consecutive cycles", async () => {
            seedContract(db, "CONTRACT_3CYCLE", "testnet", [
                { keyXdr: "c3-key", type: "instance", liveUntil: LEDGER + 3000 },
            ]);
            addWebhookAlert(db, "CONTRACT_3CYCLE", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "c3-key", liveUntilLedgerSeq: LEDGER + 3000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 3000 }],
            });

            const r1 = await runMonitorCycle(db, "testnet");
            const r2 = await runMonitorCycle(db, "testnet");
            const r3 = await runMonitorCycle(db, "testnet");

            expect(r1.thresholdsCrossed).toBe(1);
            expect(r2.thresholdsCrossed).toBe(0);
            expect(r3.thresholdsCrossed).toBe(0);
        });

        it("re-fires after alert is manually resolved and TTL drops again", async () => {
            const { resolveAlerts } = await import("../../src/db/repositories.js");

            seedContract(db, "CONTRACT_REFIRE", "testnet", [
                { keyXdr: "rf-key", type: "instance", liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_REFIRE", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "rf-key", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 }],
            });

            await runMonitorCycle(db, "testnet");

            const entries = getEntriesForContract(db, "CONTRACT_REFIRE");
            resolveAlerts(db, entries[0]!.id);

            const result2 = await runMonitorCycle(db, "testnet");
            expect(result2.thresholdsCrossed).toBe(1);
        });
    });

    // =========================================================================
    // 5. ALERT RESOLUTION
    // =========================================================================
    describe("Alert resolution", () => {
        it("resolves open alerts when TTL recovers above threshold", async () => {
            seedContract(db, "CONTRACT_RESOLVE", "testnet", [
                { keyXdr: "resolve-key", type: "instance", liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_RESOLVE", 10000);

            // Cycle 1 — TTL below threshold
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "resolve-key", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 }],
            });
            await runMonitorCycle(db, "testnet");

            const configs = getAlertConfigsForContract(db, "CONTRACT_RESOLVE");
            const entries = getEntriesForContract(db, "CONTRACT_RESOLVE");
            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(true);

            // Cycle 2 — TTL recovered
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "resolve-key", liveUntilLedgerSeq: LEDGER + 120000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 120000 }],
            });
            const result = await runMonitorCycle(db, "testnet");

            expect(result.alertsResolved).toBeGreaterThan(0);
            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(false);
        });

        it("does not resolve alerts when TTL recovers but is still below threshold", async () => {
            seedContract(db, "CONTRACT_PARTIAL_RECOVER", "testnet", [
                { keyXdr: "pr-key", type: "instance", liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_PARTIAL_RECOVER", 20000);

            // Cycle 1 — fire alert at 5000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "pr-key", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 }],
            });
            await runMonitorCycle(db, "testnet");

            // Cycle 2 — TTL improved but still below threshold (15000 < 20000)
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "pr-key", liveUntilLedgerSeq: LEDGER + 15000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 15000 }],
            });
            const result2 = await runMonitorCycle(db, "testnet");

            expect(result2.alertsResolved).toBe(0);

            const configs = getAlertConfigsForContract(db, "CONTRACT_PARTIAL_RECOVER");
            const entries = getEntriesForContract(db, "CONTRACT_PARTIAL_RECOVER");
            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(true);
        });

        it("only resolves alerts for the entry that actually recovered", async () => {
            seedContract(db, "CONTRACT_SELECTIVE_RESOLVE", "testnet", [
                { keyXdr: "sr-instance", type: "instance",  liveUntil: LEDGER + 5000 },
                { keyXdr: "sr-wasm",     type: "wasm",      liveUntil: LEDGER + 5000 },
            ]);
            addWebhookAlert(db, "CONTRACT_SELECTIVE_RESOLVE", 10000);

            // Both fire
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "sr-instance", liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 },
                    { entryKeyXdr: "sr-wasm",     liveUntilLedgerSeq: LEDGER + 5000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000 },
                ],
            });
            await runMonitorCycle(db, "testnet");

            // Only instance recovers
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "sr-instance", liveUntilLedgerSeq: LEDGER + 100000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 100000 },
                    { entryKeyXdr: "sr-wasm",     liveUntilLedgerSeq: LEDGER + 5000,   lastModifiedLedgerSeq: LEDGER, remainingTTL: 5000   },
                ],
            });
            await runMonitorCycle(db, "testnet");

            const configs = getAlertConfigsForContract(db, "CONTRACT_SELECTIVE_RESOLVE");
            const entries = getEntriesForContract(db, "CONTRACT_SELECTIVE_RESOLVE");

            const instanceEntry = entries.find(e => e.entry_key_xdr === "sr-instance")!;
            const wasmEntry     = entries.find(e => e.entry_key_xdr === "sr-wasm")!;

            expect(hasUnresolvedAlert(db, configs[0]!.id, instanceEntry.id)).toBe(false);
            expect(hasUnresolvedAlert(db, configs[0]!.id, wasmEntry.id)).toBe(true);
        });

        it("does not spuriously increment alertsResolved when no alert was ever fired", async () => {
            seedContract(db, "CONTRACT_NO_PRIOR_ALERT", "testnet", [
                { keyXdr: "npa-key", type: "instance", liveUntil: LEDGER + 80000 },
            ]);
            addWebhookAlert(db, "CONTRACT_NO_PRIOR_ALERT", 10000);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "npa-key", liveUntilLedgerSeq: LEDGER + 80000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 80000 }],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.alertsResolved).toBe(0);
        });
    });

    // =========================================================================
    // 6. ERROR HANDLING & FAULT ISOLATION
    // =========================================================================
    describe("Error handling and fault isolation", () => {
        it("continues checking other contracts when one RPC call fails", async () => {
            seedContract(db, "CONTRACT_OK",   "testnet", [{ keyXdr: "ok-key",   type: "instance", liveUntil: LEDGER + 50000 }]);
            seedContract(db, "CONTRACT_FAIL", "testnet", [{ keyXdr: "fail-key", type: "instance", liveUntil: LEDGER + 50000 }]);

            mockGetEntryTTLs
                .mockResolvedValueOnce({
                    latestLedger: LEDGER,
                    entries: [{ entryKeyXdr: "ok-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 48000 }],
                })
                .mockRejectedValueOnce(new Error("RPC timeout"));

            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(2);
            expect(result.errors).toHaveLength(1);

            const okEntries = getEntriesForContract(db, "CONTRACT_OK");
            expect(okEntries[0]!.live_until_ledger).toBe(LEDGER + 48000);
        });

        it("collects error message referencing the failing contract ID", async () => {
            seedContract(db, "CONTRACT_ERR_ID", "testnet", [{ keyXdr: "e-key", type: "instance", liveUntil: LEDGER + 50000 }]);

            mockGetEntryTTLs.mockRejectedValue(new Error("Connection refused"));

            const result = await runMonitorCycle(db, "testnet");

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain("CONTRACT_ERR_ID");
        });

        it("handles all contracts failing and still returns a valid result", async () => {
            seedContract(db, "C_FAIL_1", "testnet", [{ keyXdr: "f1", type: "instance", liveUntil: LEDGER + 1000 }]);
            seedContract(db, "C_FAIL_2", "testnet", [{ keyXdr: "f2", type: "instance", liveUntil: LEDGER + 1000 }]);

            mockGetEntryTTLs.mockRejectedValue(new Error("Network down"));

            const result = await runMonitorCycle(db, "testnet");

            expect(result.contractsChecked).toBe(2);
            expect(result.errors).toHaveLength(2);
            expect(result.entriesUpdated).toBe(0);
            expect(result.thresholdsCrossed).toBe(0);
        });

        it("does not update the DB entry TTL when the RPC call for that contract fails", async () => {
            seedContract(db, "CONTRACT_NO_UPDATE", "testnet", [
                { keyXdr: "nu-key", type: "instance", liveUntil: LEDGER + 99999 },
            ]);

            mockGetEntryTTLs.mockRejectedValue(new Error("Timeout"));

            await runMonitorCycle(db, "testnet");

            const entries = getEntriesForContract(db, "CONTRACT_NO_UPDATE");
            expect(entries[0]!.live_until_ledger).toBe(LEDGER + 99999);
        });

        it("handles a contract with no entries in the database gracefully", async () => {
            // Insert contract but no entries
            insertContract(db, { id: "CONTRACT_EMPTY_ENTRIES", network: "testnet" });

            const result = await runMonitorCycle(db, "testnet");

            // Should count the contract but skip the RPC call if no entries
            expect(result.errors).toHaveLength(0);
        });
    });

    // =========================================================================
    // 7. MULTI-THRESHOLD SCENARIOS
    // =========================================================================
    describe("Multiple alert thresholds", () => {
        it("correctly tracks which threshold fired independently — not all or nothing", async () => {
            seedContract(db, "CONTRACT_TIERED", "testnet", [
                { keyXdr: "tier-key", type: "instance", liveUntil: LEDGER + 20000 },
            ]);
            // Warning at 20000, Critical at 5000
            addWebhookAlert(db, "CONTRACT_TIERED", 20000, "https://warning.example.com");
            addWebhookAlert(db, "CONTRACT_TIERED", 5000,  "https://critical.example.com");

            // TTL drops to 18000 — crosses 20000 threshold but NOT 5000
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "tier-key", liveUntilLedgerSeq: LEDGER + 18000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 18000 }],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(1);

            const configs = getAlertConfigsForContract(db, "CONTRACT_TIERED");
            const entries = getEntriesForContract(db, "CONTRACT_TIERED");

            const warningConfig  = configs.find(c => c.threshold_ledgers === 20000)!;
            const criticalConfig = configs.find(c => c.threshold_ledgers === 5000)!;

            expect(hasUnresolvedAlert(db, warningConfig.id, entries[0]!.id)).toBe(true);
            expect(hasUnresolvedAlert(db, criticalConfig.id, entries[0]!.id)).toBe(false);
        });

        it("fires second threshold when TTL drops further, without re-firing the first", async () => {
            seedContract(db, "CONTRACT_ESCALATE", "testnet", [
                { keyXdr: "esc-key", type: "instance", liveUntil: LEDGER + 20000 },
            ]);
            addWebhookAlert(db, "CONTRACT_ESCALATE", 20000, "https://warning.example.com");
            addWebhookAlert(db, "CONTRACT_ESCALATE", 5000,  "https://critical.example.com");

            // Cycle 1 — crosses warning threshold
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "esc-key", liveUntilLedgerSeq: LEDGER + 18000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 18000 }],
            });
            const r1 = await runMonitorCycle(db, "testnet");
            expect(r1.thresholdsCrossed).toBe(1);

            // Cycle 2 — TTL drops further to 3000 (crosses critical)
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "esc-key", liveUntilLedgerSeq: LEDGER + 3000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 3000 }],
            });
            const r2 = await runMonitorCycle(db, "testnet");
            // Only the critical threshold fires on cycle 2 — warning already fired
            expect(r2.thresholdsCrossed).toBe(1);

            const configs = getAlertConfigsForContract(db, "CONTRACT_ESCALATE");
            const entries = getEntriesForContract(db, "CONTRACT_ESCALATE");

            expect(hasUnresolvedAlert(db, configs.find(c => c.threshold_ledgers === 20000)!.id, entries[0]!.id)).toBe(true);
            expect(hasUnresolvedAlert(db, configs.find(c => c.threshold_ledgers === 5000)!.id, entries[0]!.id)).toBe(true);
        });
    });

    // =========================================================================
    // 8. MULTIPLE CONTRACTS, INDEPENDENT ALERT STATES
    // =========================================================================
    describe("Multiple contracts with independent alert states", () => {
        it("alert state for one contract does not bleed into another", async () => {
            seedContract(db, "C_CRITICAL", "testnet", [{ keyXdr: "crit-key", type: "instance", liveUntil: LEDGER + 3000 }]);
            seedContract(db, "C_HEALTHY",  "testnet", [{ keyXdr: "heal-key", type: "instance", liveUntil: LEDGER + 80000 }]);

            addWebhookAlert(db, "C_CRITICAL", 10000);
            addWebhookAlert(db, "C_HEALTHY",  10000);

            mockGetEntryTTLs
                .mockResolvedValueOnce({
                    latestLedger: LEDGER,
                    entries: [{ entryKeyXdr: "crit-key", liveUntilLedgerSeq: LEDGER + 3000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 3000 }],
                })
                .mockResolvedValueOnce({
                    latestLedger: LEDGER,
                    entries: [{ entryKeyXdr: "heal-key", liveUntilLedgerSeq: LEDGER + 80000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 80000 }],
                });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.thresholdsCrossed).toBe(1);

            const critConfigs = getAlertConfigsForContract(db, "C_CRITICAL");
            const healConfigs = getAlertConfigsForContract(db, "C_HEALTHY");
            const critEntries = getEntriesForContract(db, "C_CRITICAL");
            const healEntries = getEntriesForContract(db, "C_HEALTHY");

            expect(hasUnresolvedAlert(db, critConfigs[0]!.id, critEntries[0]!.id)).toBe(true);
            expect(hasUnresolvedAlert(db, healConfigs[0]!.id, healEntries[0]!.id)).toBe(false);
        });
    });

    // =========================================================================
    // 9. IDEMPOTENCY & SUCCESSIVE CYCLES
    // =========================================================================
    describe("Idempotency and successive cycles", () => {
        it("running the cycle twice with no TTL change is stable", async () => {
            seedContract(db, "CONTRACT_STABLE", "testnet", [
                { keyXdr: "s-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{ entryKeyXdr: "s-key", liveUntilLedgerSeq: LEDGER + 50000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 50000 }],
            });

            const r1 = await runMonitorCycle(db, "testnet");
            const r2 = await runMonitorCycle(db, "testnet");

            expect(r1.entriesUpdated).toBe(1);
            expect(r2.entriesUpdated).toBe(1);
            expect(r1.thresholdsCrossed).toBe(0);
            expect(r2.thresholdsCrossed).toBe(0);
        });

        it("correctly accumulates entriesUpdated across multiple contracts in one cycle", async () => {
            seedContract(db, "D1", "testnet", [
                { keyXdr: "d1-a", type: "instance",   liveUntil: LEDGER + 50000 },
                { keyXdr: "d1-b", type: "wasm",       liveUntil: LEDGER + 50000 },
            ]);
            seedContract(db, "D2", "testnet", [
                { keyXdr: "d2-a", type: "instance",   liveUntil: LEDGER + 50000 },
                { keyXdr: "d2-b", type: "persistent", liveUntil: LEDGER + 50000 },
                { keyXdr: "d2-c", type: "wasm",       liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs
                .mockResolvedValueOnce({
                    latestLedger: LEDGER,
                    entries: [
                        { entryKeyXdr: "d1-a", liveUntilLedgerSeq: LEDGER + 49000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49000 },
                        { entryKeyXdr: "d1-b", liveUntilLedgerSeq: LEDGER + 49000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49000 },
                    ],
                })
                .mockResolvedValueOnce({
                    latestLedger: LEDGER,
                    entries: [
                        { entryKeyXdr: "d2-a", liveUntilLedgerSeq: LEDGER + 49000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49000 },
                        { entryKeyXdr: "d2-b", liveUntilLedgerSeq: LEDGER + 49000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49000 },
                        { entryKeyXdr: "d2-c", liveUntilLedgerSeq: LEDGER + 49000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49000 },
                    ],
                });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.entriesUpdated).toBe(5);
        });
    });

    // =========================================================================
    // 10. RPC KEY PASSING CORRECTNESS
    // =========================================================================
    describe("RPC call key correctness", () => {
        it("does not include keys from other contracts in a contract's RPC call", async () => {
            seedContract(db, "CA", "testnet", [{ keyXdr: "ca-key", type: "instance", liveUntil: LEDGER + 50000 }]);
            seedContract(db, "CB", "testnet", [{ keyXdr: "cb-key", type: "instance", liveUntil: LEDGER + 50000 }]);

            mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

            await runMonitorCycle(db, "testnet");

            const call1Keys = mockGetEntryTTLs.mock.calls[0]![0] as string[];
            const call2Keys = mockGetEntryTTLs.mock.calls[1]![0] as string[];

            // Each call should contain only one key
            expect(call1Keys).toHaveLength(1);
            expect(call2Keys).toHaveLength(1);

            // Keys should not cross-contaminate
            const allCalledKeys = [...call1Keys, ...call2Keys];
            expect(allCalledKeys).toContain("ca-key");
            expect(allCalledKeys).toContain("cb-key");
        });
    });

    // =========================================================================
    // 11. PARTIAL RPC RESPONSE (subset of keys returned)
    // =========================================================================
    describe("Partial RPC responses", () => {
        it("only updates entries that were returned by the RPC, leaves others unchanged", async () => {
            seedContract(db, "CONTRACT_PARTIAL", "testnet", [
                { keyXdr: "p-instance", type: "instance", liveUntil: LEDGER + 50000 },
                { keyXdr: "p-wasm",     type: "wasm",     liveUntil: LEDGER + 80000 },
            ]);

            // RPC only returns instance, not wasm (maybe wasm was archived)
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "p-instance", liveUntilLedgerSeq: LEDGER + 45000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 45000 },
                ],
            });

            const result = await runMonitorCycle(db, "testnet");
            expect(result.entriesUpdated).toBe(1);

            const entries = getEntriesForContract(db, "CONTRACT_PARTIAL");
            expect(entries.find(e => e.entry_key_xdr === "p-instance")!.live_until_ledger).toBe(LEDGER + 45000);
            expect(entries.find(e => e.entry_key_xdr === "p-wasm")!.live_until_ledger).toBe(LEDGER + 80000); // unchanged
        });
    });
});
