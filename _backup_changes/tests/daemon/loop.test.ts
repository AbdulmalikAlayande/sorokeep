import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import type { MonitorCycleResult } from "../../src/core/monitor";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRunMonitorCycle = vi.fn();
const mockDeliverPendingAlerts = vi.fn();

vi.mock("../../src/core/monitor.js", () => ({
    runMonitorCycle: (...args: unknown[]) => mockRunMonitorCycle(...args),
}));

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverPendingAlerts: (...args: unknown[]) => mockDeliverPendingAlerts(...args),
}));

import { startDaemon, stopDaemon } from "../../src/daemon/loop.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCycleResult(overrides: Partial<MonitorCycleResult> = {}): MonitorCycleResult {
    return {
        contractsChecked: 0,
        entriesUpdated: 0,
        thresholdsCrossed: 0,
        alertsResolved: 0,
        errors: [],
        cycleStartedAt: new Date(),
        cycleFinishedAt: new Date(),
        ...overrides,
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("daemon loop", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        vi.useFakeTimers();
        // Default: deliver succeeds silently so loop tests focus on cycle behaviour
        mockDeliverPendingAlerts.mockResolvedValue({
            attempted: 0,
            delivered: 0,
            failed: 0,
            errors: [],
        });
    });

    afterEach(() => {
        stopDaemon();
        vi.useRealTimers();
    });

    // =========================================================================
    // 1. STARTUP & INITIAL CYCLE
    // =========================================================================
    describe("Startup and initial cycle", () => {
        it("runs an initial cycle immediately on start", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 300000 });

            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledWith(db, "testnet", undefined);
        });

        it("passes the custom rpcUrl to runMonitorCycle when provided", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "mainnet", {
                intervalMs: 60000,
                rpcUrl: "https://custom-rpc.example.com",
            });

            expect(mockRunMonitorCycle).toHaveBeenCalledWith(
                db,
                "mainnet",
                "https://custom-rpc.example.com",
            );
        });

        it("resolves the startDaemon promise even if the initial cycle throws", async () => {
            mockRunMonitorCycle.mockRejectedValueOnce(new Error("DB locked"));

            // startDaemon should NOT reject — the daemon must stay alive
            await expect(
                startDaemon(db, "testnet", { intervalMs: 5000 }),
            ).resolves.not.toThrow();
        });

        it("still schedules subsequent cycles after an initial cycle failure", async () => {
            mockRunMonitorCycle
                .mockRejectedValueOnce(new Error("DB locked"))
                .mockResolvedValue(makeCycleResult({ contractsChecked: 3 }));

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // 2. INTERVAL SCHEDULING
    // =========================================================================
    describe("Interval scheduling", () => {
        it("runs subsequent cycles at the configured interval", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);
        });

        it("uses default 5-minute interval when none specified", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet");
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // 4 minutes — should NOT trigger
            await vi.advanceTimersByTimeAsync(240000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // 5 minutes total — should trigger
            await vi.advanceTimersByTimeAsync(60000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("does NOT fire a cycle before the interval elapses", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 10000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // 9999ms — just under the interval
            await vi.advanceTimersByTimeAsync(9999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // 1ms more — now at exactly 10000
            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("runs the correct number of cycles over a large time span", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 10000 });

            // Advance 1 minute = 6 intervals → 6 additional cycles + 1 initial = 7
            await vi.advanceTimersByTimeAsync(60000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(7);
        });
    });

    // =========================================================================
    // 3. GRACEFUL SHUTDOWN
    // =========================================================================
    describe("Graceful shutdown", () => {
        it("stops running cycles after stopDaemon is called", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            stopDaemon();

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Even after multiple intervals
            await vi.advanceTimersByTimeAsync(50000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);
        });

        it("stopDaemon is idempotent — calling it twice does not throw", () => {
            expect(() => {
                stopDaemon();
                stopDaemon();
            }).not.toThrow();
        });

        it("stopDaemon before startDaemon is a safe no-op", () => {
            expect(() => stopDaemon()).not.toThrow();
        });

        it("can restart the daemon after stopping it", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            // First run
            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            stopDaemon();

            // Second run — should work fine
            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);
        });

        it("no cycles fire after stopDaemon even over a long simulated period", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            stopDaemon();

            // Simulate 1 hour
            await vi.advanceTimersByTimeAsync(3600000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1); // only initial
        });
    });

    // =========================================================================
    // 4. ERROR RESILIENCE
    // =========================================================================
    describe("Error resilience", () => {
        it("continues running after a single cycle throws", async () => {
            mockRunMonitorCycle
                .mockRejectedValueOnce(new Error("RPC down"))
                .mockResolvedValue(makeCycleResult({ contractsChecked: 1 }));

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("survives multiple consecutive cycle failures", async () => {
            mockRunMonitorCycle
                .mockRejectedValueOnce(new Error("Failure 1"))
                .mockRejectedValueOnce(new Error("Failure 2"))
                .mockRejectedValueOnce(new Error("Failure 3"))
                .mockResolvedValue(makeCycleResult({ contractsChecked: 5 }));

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            // Three more intervals — first three fail, fourth succeeds
            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000);

            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(4);
        });

        it("does not crash on non-Error exceptions (e.g., thrown strings)", async () => {
            mockRunMonitorCycle
                .mockRejectedValueOnce("string error")
                .mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // 5. RE-ENTRANCE GUARD
    // =========================================================================
    describe("Re-entrance guard", () => {
        it("does not run overlapping cycles if a cycle takes longer than the interval", async () => {
            let resolveSlowCycle!: (value: MonitorCycleResult) => void;

            // First cycle resolves immediately (initial)
            mockRunMonitorCycle.mockResolvedValueOnce(makeCycleResult());

            // Second cycle is slow — takes longer than the interval
            mockRunMonitorCycle.mockImplementationOnce(() => {
                return new Promise<MonitorCycleResult>((resolve) => {
                    resolveSlowCycle = resolve;
                });
            });

            // Third cycle should only run after the slow one finishes
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Trigger second cycle (slow)
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // Advance past another interval while second cycle is still in-flight
            await vi.advanceTimersByTimeAsync(5000);
            // Should still be 2 — no overlapping cycle started
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // Now resolve the slow cycle
            resolveSlowCycle(makeCycleResult());
            await vi.advanceTimersByTimeAsync(0); // flush microtasks

            // After the slow cycle resolves and the next interval fires, cycle 3 runs
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);
        });
    });

    // =========================================================================
    // 6. DUPLICATE START PROTECTION
    // =========================================================================
    describe("Duplicate start protection", () => {
        it("calling startDaemon while already running stops the previous loop first", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 10000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Start again with a different interval
            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // The old 10s timer should be dead — only the new 5s timer lives
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);

            // If old timer was still alive, we'd see 4 calls at 10s
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(4);
        });
    });

    // =========================================================================
    // 7. ARGUMENT FORWARDING
    // =========================================================================
    describe("Argument forwarding", () => {
        it("forwards db and network to every cycle call", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "mainnet", { intervalMs: 5000 });

            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000);

            // 3 total calls: initial + 2 interval
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);

            for (const call of mockRunMonitorCycle.mock.calls) {
                expect(call[0]).toBe(db);
                expect(call[1]).toBe("mainnet");
            }
        });

        it("forwards rpcUrl to every subsequent cycle, not just the first", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", {
                intervalMs: 5000,
                rpcUrl: "https://rpc.stellar.org",
            });

            await vi.advanceTimersByTimeAsync(5000);

            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            for (const call of mockRunMonitorCycle.mock.calls) {
                expect(call[2]).toBe("https://rpc.stellar.org");
            }
        });

        it("forwards undefined rpcUrl when not provided", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            await vi.advanceTimersByTimeAsync(5000);

            for (const call of mockRunMonitorCycle.mock.calls) {
                expect(call[2]).toBeUndefined();
            }
        });
    });

    // =========================================================================
    // 8. LIFECYCLE CALLBACK (onCycle hook)
    // =========================================================================
    describe("onCycle callback", () => {
        it("calls onCycle with the result after each successful cycle", async () => {
            const onCycle = vi.fn();
            const result = makeCycleResult({ contractsChecked: 7 });
            mockRunMonitorCycle.mockResolvedValue(result);

            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            expect(onCycle).toHaveBeenCalledTimes(1);
            expect(onCycle).toHaveBeenCalledWith(result, undefined);

            await vi.advanceTimersByTimeAsync(5000);
            expect(onCycle).toHaveBeenCalledTimes(2);
        });

        it("calls onCycle with null or error info when a cycle throws", async () => {
            const onCycle = vi.fn();
            const error = new Error("RPC timeout");
            mockRunMonitorCycle
                .mockRejectedValueOnce(error)
                .mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Even on failure, onCycle should be called (with error context)
            expect(onCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(onCycle).toHaveBeenCalledTimes(2);
        });

        it("does not crash the daemon if onCycle itself throws", async () => {
            const onCycle = vi.fn().mockImplementation(() => {
                throw new Error("callback exploded");
            });
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            // Daemon should survive the callback error
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("is not required — daemon works fine without it", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // 9. CYCLE COUNTING & STATE
    // =========================================================================
    describe("Cycle counting", () => {
        it("each cycle is a fresh call — no stale state leaks between cycles", async () => {
            const result1 = makeCycleResult({ contractsChecked: 2, thresholdsCrossed: 1 });
            const result2 = makeCycleResult({ contractsChecked: 3, thresholdsCrossed: 0 });

            mockRunMonitorCycle
                .mockResolvedValueOnce(result1)
                .mockResolvedValueOnce(result2);

            const onCycle = vi.fn();
            await startDaemon(db, "testnet", { intervalMs: 5000, onCycle });

            await vi.advanceTimersByTimeAsync(5000);

            // Each callback receives its own cycle result, not accumulated
            expect(onCycle).toHaveBeenNthCalledWith(1, result1, undefined);
            expect(onCycle).toHaveBeenNthCalledWith(2, result2, undefined);
        });
    });
});
