import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, upsertEntry, getEntriesForContract } from "../../src/db/repositories";
import { startDaemon, stopDaemon } from "../../src/daemon/loop";
import type { MonitorCycleResult } from "../../src/core/monitor";

// ─── Mock RPC Client ───────────────────────────────────────────────────────────

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

// ─── Mock Alert Dispatcher ─────────────────────────────────────────────────────

const mockDeliverPendingAlerts = vi.fn();
const mockRunAutoExtensions = vi.fn();

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverPendingAlerts: (...args: unknown[]) => mockDeliverPendingAlerts(...args),
}));

vi.mock("../../src/core/extension.js", () => ({
    runAutoExtensions: (...args: unknown[]) => mockRunAutoExtensions(...args),
}));

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("e2e: monitoring daemon execution cycles", () => {
    let db: Database.Database;
    const LEDGER = 2_500_000;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        vi.useFakeTimers();
        
        // Default mock responses
        mockGetCurrentLedger.mockResolvedValue(LEDGER);
        mockDeliverPendingAlerts.mockResolvedValue({
            attempted: 0,
            delivered: 0,
            failed: 0,
            errors: [],
        });
        mockRunAutoExtensions.mockResolvedValue({
            contractsChecked: 0,
            contractsExtended: 0,
            entriesExtended: 0,
            errors: [],
            extensions: [],
        });
    });

    afterEach(() => {
        stopDaemon();
        vi.useRealTimers();
    });

    // =========================================================================
    // 1. FULL CYCLE EXECUTION
    // =========================================================================
    describe("Full cycle execution", () => {
        it("executes complete monitoring cycles with real monitor cycle logic", async () => {
            seedContract(db, "CONTRACT_1", "testnet", [
                { keyXdr: "key-1", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "key-1", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Initial cycle should complete
            expect(onCycle).toHaveBeenCalledTimes(1);
            const firstResult = onCycle.mock.calls[0][0] as MonitorCycleResult;
            expect(firstResult).not.toBeNull();
            expect(firstResult.contractsChecked).toBe(1);
            expect(firstResult.entriesUpdated).toBe(1);

            // Verify database was actually updated
            const entries = getEntriesForContract(db, "CONTRACT_1");
            expect(entries[0].live_until_ledger).toBe(LEDGER + 48000);
        });

        it("executes multiple cycles over time with state persistence", async () => {
            seedContract(db, "CONTRACT_MULTI", "testnet", [
                { keyXdr: "key-a", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            // Cycle 1: TTL drops to 48000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "key-a", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            // Cycle 2: TTL drops further to 45000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER + 3000,
                entries: [
                    { entryKeyXdr: "key-a", liveUntilLedgerSeq: LEDGER + 45000, lastModifiedLedgerSeq: LEDGER + 2990, remainingTTL: 45000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Advance to trigger second cycle
            await vi.advanceTimersByTimeAsync(5000);

            expect(onCycle).toHaveBeenCalledTimes(2);
            
            const result1 = onCycle.mock.calls[0][0] as MonitorCycleResult;
            const result2 = onCycle.mock.calls[1][0] as MonitorCycleResult;

            expect(result1.entriesUpdated).toBe(1);
            expect(result2.entriesUpdated).toBe(1);

            // Verify final state in database
            const entries = getEntriesForContract(db, "CONTRACT_MULTI");
            expect(entries[0].live_until_ledger).toBe(LEDGER + 45000);
        });

        it("processes multiple contracts across cycles", async () => {
            seedContract(db, "CONTRACT_A", "testnet", [
                { keyXdr: "a-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);
            seedContract(db, "CONTRACT_B", "testnet", [
                { keyXdr: "b-key", type: "wasm", liveUntil: LEDGER + 60000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "a-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                    { entryKeyXdr: "b-key", liveUntilLedgerSeq: LEDGER + 58000, lastModifiedLedgerSeq: LEDGER - 20, remainingTTL: 58000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            const result = onCycle.mock.calls[0][0] as MonitorCycleResult;
            expect(result.contractsChecked).toBe(2);
            expect(result.entriesUpdated).toBe(2);
        });
    });

    // =========================================================================
    // 2. CYCLE TIMING AND SCHEDULING
    // =========================================================================
    describe("Cycle timing and scheduling", () => {
        it("maintains consistent interval timing across multiple cycles", async () => {
            seedContract(db, "CONTRACT_TIMING", "testnet", [
                { keyXdr: "timing-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "timing-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 10000, onCycle });

            expect(onCycle).toHaveBeenCalledTimes(1);

            // Advance exactly 10 seconds - should trigger second cycle
            await vi.advanceTimersByTimeAsync(10000);
            expect(onCycle).toHaveBeenCalledTimes(2);

            // Advance another 10 seconds - should trigger third cycle
            await vi.advanceTimersByTimeAsync(10000);
            expect(onCycle).toHaveBeenCalledTimes(3);

            // Advance only 5 seconds - should NOT trigger
            await vi.advanceTimersByTimeAsync(5000);
            expect(onCycle).toHaveBeenCalledTimes(3);
        });

        it("records accurate cycle timestamps", async () => {
            seedContract(db, "CONTRACT_TIME", "testnet", [
                { keyXdr: "time-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "time-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            const result = onCycle.mock.calls[0][0] as MonitorCycleResult;
            
            expect(result.cycleStartedAt).toBeInstanceOf(Date);
            expect(result.cycleFinishedAt).toBeInstanceOf(Date);
            expect(result.cycleFinishedAt.getTime()).toBeGreaterThanOrEqual(
                result.cycleStartedAt.getTime()
            );
        });
    });

    // =========================================================================
    // 3. ERROR RESILIENCE IN REAL EXECUTION
    // =========================================================================
    describe("Error resilience in real execution", () => {
        it("continues daemon execution after RPC failures", async () => {
            seedContract(db, "CONTRACT_RESILIENT", "testnet", [
                { keyXdr: "resilient-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            // First cycle fails
            mockGetEntryTTLs.mockRejectedValueOnce(new Error("RPC timeout"));
            
            // Second cycle succeeds
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "resilient-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // First cycle should complete with error in result
            expect(onCycle).toHaveBeenCalledTimes(1);
            expect(onCycle.mock.calls[0][0]).not.toBeNull();
            expect(onCycle.mock.calls[0][0].errors).toHaveLength(1);
            expect(onCycle.mock.calls[0][1]).toBeUndefined();

            // Advance to trigger second cycle
            await vi.advanceTimersByTimeAsync(5000);

            // Second cycle should succeed
            expect(onCycle).toHaveBeenCalledTimes(2);
            const result = onCycle.mock.calls[1][0] as MonitorCycleResult;
            expect(result).not.toBeNull();
            expect(result.contractsChecked).toBe(1);
        });

        it("handles partial contract failures gracefully", async () => {
            seedContract(db, "CONTRACT_OK", "testnet", [
                { keyXdr: "ok-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);
            seedContract(db, "CONTRACT_FAIL", "testnet", [
                { keyXdr: "fail-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            // First contract succeeds, second fails
            mockGetEntryTTLs.mockImplementation(async (keys) => {
                const keyArray = keys as string[];
                if (keyArray.includes("ok-key")) {
                    return {
                        latestLedger: LEDGER,
                        entries: [
                            { entryKeyXdr: "ok-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                        ],
                    };
                }
                throw new Error("Connection refused");
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            const result = onCycle.mock.calls[0][0] as MonitorCycleResult;
            expect(result.contractsChecked).toBe(2);
            expect(result.entriesUpdated).toBe(1);
            expect(result.errors).toHaveLength(1);

            // Verify the successful contract was updated
            const okEntries = getEntriesForContract(db, "CONTRACT_OK");
            expect(okEntries[0].live_until_ledger).toBe(LEDGER + 48000);
        });
    });

    // =========================================================================
    // 4. STATE PERSISTENCE ACROSS CYCLES
    // =========================================================================
    describe("State persistence across cycles", () => {
        it("maintains database state across multiple daemon cycles", async () => {
            seedContract(db, "CONTRACT_STATE", "testnet", [
                { keyXdr: "state-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            // Cycle 1: Update to 48000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "state-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            // Cycle 2: Update to 46000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER + 2000,
                entries: [
                    { entryKeyXdr: "state-key", liveUntilLedgerSeq: LEDGER + 46000, lastModifiedLedgerSeq: LEDGER + 1990, remainingTTL: 46000 },
                ],
            });

            // Cycle 3: Update to 44000
            mockGetEntryTTLs.mockResolvedValueOnce({
                latestLedger: LEDGER + 4000,
                entries: [
                    { entryKeyXdr: "state-key", liveUntilLedgerSeq: LEDGER + 44000, lastModifiedLedgerSeq: LEDGER + 3990, remainingTTL: 44000 },
                ],
            });

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Trigger two more cycles and wait for them to complete
            const cycle2Promise = new Promise(resolve => {
                onCycle.mockImplementationOnce(resolve);
            });
            await vi.advanceTimersByTimeAsync(5000);
            await cycle2Promise;

            const cycle3Promise = new Promise(resolve => {
                onCycle.mockImplementationOnce(resolve);
            });
            await vi.advanceTimersByTimeAsync(5000);
            await cycle3Promise;

            expect(onCycle).toHaveBeenCalledTimes(3);

            // Verify final state
            const entries = getEntriesForContract(db, "CONTRACT_STATE");
            expect(entries[0].live_until_ledger).toBe(LEDGER + 44000);
        });

        it("persists last_checked_ledger across cycles", async () => {
            seedContract(db, "CONTRACT_LEDGER_STATE", "testnet", [
                { keyXdr: "ledger-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "ledger-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            const { getContract } = await import("../../src/db/repositories");
            const contract = getContract(db, "CONTRACT_LEDGER_STATE");
            expect(contract?.last_checked_ledger).toBe(LEDGER);
        });
    });

    // =========================================================================
    // 5. INTEGRATION WITH ALERT DELIVERY
    // =========================================================================
    describe("Integration with alert delivery", () => {
        it("calls alert delivery after successful monitor cycle", async () => {
            seedContract(db, "CONTRACT_ALERTS", "testnet", [
                { keyXdr: "alert-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "alert-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            expect(mockDeliverPendingAlerts).toHaveBeenCalledTimes(1);
            expect(mockDeliverPendingAlerts).toHaveBeenCalledWith(db, "testnet");
        });

        it("continues execution even if alert delivery fails", async () => {
            seedContract(db, "CONTRACT_DELIVERY_FAIL", "testnet", [
                { keyXdr: "delivery-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "delivery-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            mockDeliverPendingAlerts.mockRejectedValue(new Error("Webhook failed"));

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Cycle should still complete successfully despite delivery failure
            const result = onCycle.mock.calls[0][0] as MonitorCycleResult;
            expect(result).not.toBeNull();
            expect(result.contractsChecked).toBe(1);
        });
    });

    // =========================================================================
    // 6. INTEGRATION WITH AUTO-EXTENSIONS
    // =========================================================================
    describe("Integration with auto-extensions", () => {
        it("calls auto-extensions after successful monitor cycle", async () => {
            seedContract(db, "CONTRACT_EXTEND", "testnet", [
                { keyXdr: "extend-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "extend-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            expect(mockRunAutoExtensions).toHaveBeenCalledTimes(1);
            expect(mockRunAutoExtensions).toHaveBeenCalledWith(db, "testnet", undefined, undefined);
        });

        it("continues execution even if auto-extensions fails", async () => {
            seedContract(db, "CONTRACT_EXTEND_FAIL", "testnet", [
                { keyXdr: "extend-fail-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "extend-fail-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            mockRunAutoExtensions.mockRejectedValue(new Error("Extension failed"));

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Cycle should still complete successfully
            const result = onCycle.mock.calls[0][0] as MonitorCycleResult;
            expect(result).not.toBeNull();
            expect(result.contractsChecked).toBe(1);
        });
    });

    // =========================================================================
    // 7. DAEMON LIFECYCLE
    // =========================================================================
    describe("Daemon lifecycle", () => {
        it("stops and restarts cleanly with state preservation", async () => {
            seedContract(db, "CONTRACT_LIFECYCLE", "testnet", [
                { keyXdr: "lifecycle-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "lifecycle-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            // First run
            const onCycle1 = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle: onCycle1 });
            expect(onCycle1).toHaveBeenCalledTimes(1);

            stopDaemon();

            // Second run - should work fine
            const onCycle2 = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle: onCycle2 });
            expect(onCycle2).toHaveBeenCalledTimes(1);

            // State should be preserved from first run
            const entries = getEntriesForContract(db, "CONTRACT_LIFECYCLE");
            expect(entries[0].live_until_ledger).toBe(LEDGER + 48000);
        });

        it("handles rapid start-stop cycles gracefully", async () => {
            seedContract(db, "CONTRACT_RAPID", "testnet", [
                { keyXdr: "rapid-key", type: "instance", liveUntil: LEDGER + 50000 },
            ]);

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [
                    { entryKeyXdr: "rapid-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
                ],
            });

            // Start and stop multiple times rapidly
            for (let i = 0; i < 3; i++) {
                await startDaemon(db, "testnet", { intervalMs: 5000 });
                stopDaemon();
            }

            // Final start should work
            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });
            expect(onCycle).toHaveBeenCalledTimes(1);
        });
    });
});
