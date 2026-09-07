import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import type { MonitorCycleResult } from "../../src/core/monitor";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRunMonitorCycle = vi.fn();
const mockDeliverPendingAlerts = vi.fn();
const mockVacuumDatabase = vi.fn();
const mockAggregateDailyCostSnapshots = vi.fn();
const mockDaemonLogger = vi.hoisted(() => {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    return logger;
});

vi.mock("../../src/core/monitor.js", () => ({
    runMonitorCycle: (...args: unknown[]) => mockRunMonitorCycle(...args),
}));

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverPendingAlerts: (...args: unknown[]) => mockDeliverPendingAlerts(...args),
}));

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/db/database.js")>();
    return {
        ...actual,
        vacuumDatabase: (...args: unknown[]) => mockVacuumDatabase(...args),
    };
});

vi.mock("../../src/db/repositories.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/db/repositories.js")>();
    return {
        ...actual,
        aggregateDailyCostSnapshots: (...args: unknown[]) => mockAggregateDailyCostSnapshots(...args),
    };
});

vi.mock("../../src/logging/index.js", () => ({
    getLogger: () => mockDaemonLogger,
}));

import { startDaemon, stopDaemon } from "../../src/daemon/loop.js";
import { insertContract, createGroup, addContractToGroup, setGroupPollInterval } from "../../src/db/repositories.js";
import { daemonCycleDuration, daemonCyclesSkipped } from "../../src/observability/metrics/daemon.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCycleResult(overrides: Partial<MonitorCycleResult> = {}): MonitorCycleResult {
    return {
        contractsChecked: 0,
        entriesUpdated: 0,
        thresholdsCrossed: 0,
        alertsResolved: 0,
        extensionsTriggered: 0,
        extensionErrors: [],
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
        daemonCycleDuration.reset();
        daemonCyclesSkipped.reset();
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
    // 0. MAINTENANCE
    // =========================================================================
    describe("Maintenance", () => {
        it("runs scheduled vacuum only when the configured interval has elapsed", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            await startDaemon(db, "testnet", { intervalMs: 5000, vacuumIntervalMs: 5000 });
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2);
        });

        it("handles forward system clock jumps without vacuuming on every tick", async () => {
            // Simulate a system clock jump (DST, NTP correction, or wake from suspend)
            // where the clock suddenly jumps forward by a large amount.
            // The vacuum check uses Date.now() - lastVacuumAt, so a forward jump
            // should cause the next vacuum to fire immediately (since enough time
            // has "passed" according to the clock), but NOT on every subsequent tick.

            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            const tickMs = 5000;
            const vacuumIntervalMs = 20000;

            // Start at a known time
            vi.setSystemTime(1000000);

            await startDaemon(db, "testnet", { intervalMs: tickMs, vacuumIntervalMs });
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);

            // Advance to the first vacuum (20s elapsed)
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);

            // Now simulate a large forward clock jump (e.g., system woke from suspend
            // after 2 hours). Set system time forward by 2 hours.
            const currentTime = Date.now();
            const clockJumpMs = 2 * 60 * 60 * 1000; // 2 hours
            vi.setSystemTime(currentTime + clockJumpMs);

            // Advance one tick — the vacuum should fire because
            // Date.now() - lastVacuumAt is now 2+ hours, which is >= vacuumIntervalMs
            await vi.advanceTimersByTimeAsync(tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2);

            // BUT — the next tick should NOT vacuum again, because lastVacuumAt
            // was updated when vacuum ran. Advance another tick (5s).
            await vi.advanceTimersByTimeAsync(tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2); // still 2

            // Advance the remaining interval to verify normal behavior resumes
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs - tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(3);
        });

        it("handles backward system clock jumps without skipping vacuum indefinitely", async () => {
            // Simulate a backward clock jump (manual clock adjustment, NTP correction).
            // The vacuum check uses Date.now() - lastVacuumAt, so if the clock jumps
            // backward, lastVacuumAt could be in the "future" relative to Date.now(),
            // causing Date.now() - lastVacuumAt to be negative or very small.
            // We want to verify that vacuum doesn't get skipped forever.

            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            const tickMs = 5000;
            const vacuumIntervalMs = 20000;

            // Start at a known time
            vi.setSystemTime(2000000);

            await startDaemon(db, "testnet", { intervalMs: tickMs, vacuumIntervalMs });
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);

            // Advance to the first vacuum (20s elapsed)
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);

            // Now simulate a backward clock jump (e.g., clock was wrong and gets corrected).
            // Jump back by 1 hour.
            const currentTime = Date.now();
            const clockJumpMs = -1 * 60 * 60 * 1000; // -1 hour
            vi.setSystemTime(currentTime + clockJumpMs);

            // After a backward jump, Date.now() - lastVacuumAt will be negative
            // (lastVacuumAt is now in the "future"). The current implementation
            // will skip vacuum until the clock catches up to lastVacuumAt + vacuumIntervalMs.

            // Advance several ticks — vacuum should NOT fire yet because
            // Date.now() - lastVacuumAt < vacuumIntervalMs (it's negative).
            await vi.advanceTimersByTimeAsync(tickMs);
            await vi.advanceTimersByTimeAsync(tickMs);
            await vi.advanceTimersByTimeAsync(tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1); // still 1

            // Now advance the clock enough to catch up past the backward jump
            // plus the vacuum interval. We need to advance by:
            // (1 hour to catch up) + (20s vacuum interval)
            const catchUpMs = Math.abs(clockJumpMs) + vacuumIntervalMs;
            await vi.advanceTimersByTimeAsync(catchUpMs);

            // Vacuum should have fired at some point during this advancement
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2);

            // Verify normal behavior resumes
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(3);
        });

        it("skips scheduled vacuum when the database is already in a transaction", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            await startDaemon(db, "testnet", { intervalMs: 5000, vacuumIntervalMs: 5000 });
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);

            db.exec("BEGIN IMMEDIATE");
            expect(db.inTransaction).toBe(true);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);

            db.exec("ROLLBACK");
            expect(db.inTransaction).toBe(false);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);
        });

        it("does not update lastVacuumAt when vacuum is skipped due to an active transaction, so the next tick retries immediately", async () => {
            // Use a vacuum interval much larger than the tick interval so we can
            // observe whether lastVacuumAt was updated or not by checking if
            // vacuum fires on the very next tick after the transaction ends.
            const vacuumIntervalMs = 20000;
            const tickMs = 5000;

            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            await startDaemon(db, "testnet", { intervalMs: tickMs, vacuumIntervalMs });

            // Advance until the first vacuum fires (at Date.now() === vacuumIntervalMs).
            // Ticks at 5s, 10s, 15s — none fire vacuum (not enough elapsed).
            // Tick at 20s — fires the first vacuum.
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Scheduled maintenance: database vacuum completed",
            );

            // Now open an explicit transaction to force a skip.
            db.exec("BEGIN IMMEDIATE");
            expect(db.inTransaction).toBe(true);

            // Advance another full vacuum interval — the vacuum check should run
            // but be skipped because of the active transaction, WITHOUT updating
            // lastVacuumAt.
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1); // still 1 — skipped
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Skipping scheduled vacuum — database has an active transaction",
            );

            // Close the transaction.
            db.exec("ROLLBACK");
            expect(db.inTransaction).toBe(false);

            // Advance just ONE tick (5000ms). If lastVacuumAt had been updated
            // during the skip (to ~40000), then 45000 - 40000 = 5000 < 20000
            // and vacuum would NOT fire. But since lastVacuumAt is still at
            // the old value (~20000), 45000 - 20000 = 25000 >= 20000, so
            // vacuum fires immediately on this tick.
            await vi.advanceTimersByTimeAsync(tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2);
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Scheduled maintenance: database vacuum completed",
            );

            // Confirm that after the successful vacuum, lastVacuumAt WAS
            // updated — advancing by less than a full vacuum interval should
            // NOT trigger another vacuum.
            mockVacuumDatabase.mockClear();
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs - tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(0);
        });

        it("updates lastVacuumAt after a successful vacuum, preventing premature re-vacuum", async () => {
            const vacuumIntervalMs = 20000;
            const tickMs = 5000;

            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockVacuumDatabase.mockReturnValue(true);

            await startDaemon(db, "testnet", { intervalMs: tickMs, vacuumIntervalMs });

            // Let the first vacuum fire at the 20s mark.
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Scheduled maintenance: database vacuum completed",
            );

            // Advance by less than a full vacuum interval — vacuum should NOT
            // fire, proving lastVacuumAt was updated and the interval is being
            // respected.
            await vi.advanceTimersByTimeAsync(vacuumIntervalMs - tickMs); // 15s more
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(1);

            // One more tick completes the full interval — vacuum fires again.
            await vi.advanceTimersByTimeAsync(tickMs);
            expect(mockVacuumDatabase).toHaveBeenCalledTimes(2);
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Scheduled maintenance: database vacuum completed",
            );
        });
    });

    // =========================================================================
    // 1. STARTUP & INITIAL CYCLE
    // =========================================================================
    describe("Startup and initial cycle", () => {
        it("runs an initial cycle immediately on start", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 300000 });

            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledWith(db, "testnet", undefined, undefined);
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
                undefined,
            );
        });

        it("resolves the startDaemon promise even if the initial cycle throws", async () => {
            mockRunMonitorCycle.mockRejectedValueOnce(new Error("DB locked"));

            // startDaemon should NOT reject — the daemon must stay alive
            await expect(
                startDaemon(db, "testnet", { intervalMs: 5000 }),
            ).resolves.not.toThrow();
        });

        it("calls daily snapshot aggregation after each cycle", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockAggregateDailyCostSnapshots).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5000);
            expect(mockAggregateDailyCostSnapshots).toHaveBeenCalledTimes(2);
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

        it("uses the smallest watched contract poll interval override for the network", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            insertContract(db, {
                id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
                name: "override-1",
                network: "testnet",
                poll_interval_seconds: 300,
            });
            insertContract(db, {
                id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O",
                name: "override-2",
                network: "testnet",
                poll_interval_seconds: 600,
            });

            await startDaemon(db, "testnet", { intervalMs: 900000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(299999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
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
    describe("Metrics instrumentation", () => {
        it("records a cycle-duration observation after a completed cycle", async () => {
            const startedAt = new Date("2026-01-01T00:00:00.000Z");
            const finishedAt = new Date("2026-01-01T00:00:02.500Z");
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult({ cycleStartedAt: startedAt, cycleFinishedAt: finishedAt }));

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            const { values } = await daemonCycleDuration.get();
            const sumSample = values.find((v) => v.metricName?.endsWith("_sum") && v.labels.network === "testnet");
            expect(sumSample?.value).toBeCloseTo(2.5, 3);
        });

        it("increments the skipped-cycles counter when a tick is skipped due to an in-flight cycle", async () => {
            let resolveSlowCycle!: (value: MonitorCycleResult) => void;

            mockRunMonitorCycle.mockResolvedValueOnce(makeCycleResult());
            mockRunMonitorCycle.mockImplementationOnce(() => new Promise<MonitorCycleResult>((resolve) => { resolveSlowCycle = resolve; }));

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            await vi.advanceTimersByTimeAsync(5000); // triggers the slow cycle

            const findSkipped = async () =>
                (await daemonCyclesSkipped.get()).values.find((v) => v.labels.network === "testnet")?.value ?? 0;

            const before = await findSkipped();

            // A tick fires while the slow cycle is still in flight — should be skipped.
            await vi.advanceTimersByTimeAsync(5000);

            const after = await findSkipped();
            expect(after).toBe(before + 1);

            resolveSlowCycle(makeCycleResult());
            await vi.advanceTimersByTimeAsync(0);
        });
    });

    describe("OpenTelemetry tracing", () => {
        beforeEach(async () => {
            // getTracer() lazily creates an uninstrumented provider on first
            // call from anywhere in the process (e.g. an earlier test's
            // daemon cycle) and that provider is cached — reset it so each
            // test here starts from a clean, uninitialized state.
            const { shutdownTracing } = await import("../../src/observability/tracing.js");
            await shutdownTracing();
            process.env["SOROKEEP_OTLP_IN_MEMORY"] = "true";
        });

        afterEach(async () => {
            delete process.env["SOROKEEP_OTLP_IN_MEMORY"];
            const { shutdownTracing } = await import("../../src/observability/tracing.js");
            await shutdownTracing();
        });

        it("produces a parent span with Monitor/Deliver/CostAggregation child spans after a completed cycle", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            const { initTracing, getInMemoryExporter } = await import("../../src/observability/tracing.js");
            await initTracing();

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            const spans = getInMemoryExporter()!.getFinishedSpans();
            const spanNames = spans.map((s) => s.name);

            expect(spanNames).toContain("DaemonCycle");
            expect(spanNames).toContain("Monitor");
            expect(spanNames).toContain("Deliver");
            expect(spanNames).toContain("CostAggregation");

            const parentSpan = spans.find((s) => s.name === "DaemonCycle")!;
            for (const childName of ["Monitor", "Deliver", "CostAggregation"]) {
                const childSpan = spans.find((s) => s.name === childName)!;
                expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
            }
        });

        it("records error status on the Monitor span when runMonitorCycle throws", async () => {
            mockRunMonitorCycle.mockRejectedValueOnce(new Error("RPC failure"));
            const { initTracing, getInMemoryExporter } = await import("../../src/observability/tracing.js");
            await initTracing();

            await startDaemon(db, "testnet", { intervalMs: 5000 });

            const spans = getInMemoryExporter()!.getFinishedSpans();
            const monitorSpan = spans.find((s) => s.name === "Monitor")!;
            expect(monitorSpan.status.code).toBe(2); // SpanStatusCode.ERROR
        });

        it("adds no measurable behavior change to the cycle when tracing is off (default)", async () => {
            delete process.env["SOROKEEP_OTLP_IN_MEMORY"];
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await expect(startDaemon(db, "testnet", { intervalMs: 5000 })).resolves.not.toThrow();
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);
        });
    });

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

        it("does not run concurrent cycles when stopDaemon is called mid-cycle and startDaemon is called again", async () => {
            let resolveSlowCycle!: (value: MonitorCycleResult) => void;

            // First cycle (initial) resolves immediately
            mockRunMonitorCycle.mockResolvedValueOnce(makeCycleResult());

            // Second cycle is slow — we control when it resolves
            mockRunMonitorCycle.mockImplementationOnce(() => {
                return new Promise<MonitorCycleResult>((resolve) => {
                    resolveSlowCycle = resolve;
                });
            });

            // Any further cycles resolve immediately
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Trigger the slow second cycle
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // Stop the daemon while the second cycle is still in-flight
            stopDaemon();

            // Start the daemon again — the old cycle is still in-flight.
            // The initial cycle of the new daemon must be skipped by the
            // re-entrance guard (cycleInFlight is still true).
            // startDaemon calls stopDaemon internally (which must NOT reset
            // cycleInFlight) and then runs executeCycle for the initial tick.
            // However, the initial tick in startDaemon always runs executeCycle
            // directly (not via scheduledTick), so it will set cycleInFlight = true
            // again. The key point is that cycleInFlight is still true from the
            // first daemon's slow cycle, so startDaemon's initial executeCycle
            // must not cause two executeCycle calls to be running concurrently.
            //
            // Since startDaemon awaits executeCycle, and executeCycle sets
            // cycleInFlight = true at entry, the new startDaemon will block on
            // its own executeCycle. Meanwhile, the old slow cycle is also
            // in-flight concurrently. We verify that the scheduled ticks of the
            // new daemon don't spawn additional overlapping cycles.

            // Resolve the old slow cycle so that things can proceed
            resolveSlowCycle(makeCycleResult());
            await vi.advanceTimersByTimeAsync(0); // flush microtasks

            // Now start a fresh daemon — old cycle has finished
            await startDaemon(db, "testnet", { intervalMs: 5000 });
            // call 3: the fresh daemon's initial cycle
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(3);

            // Advance one interval — should trigger exactly one more cycle
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(4);

            // No extra cycles should have leaked from the old daemon
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(5);
        });

        it("re-entrance guard skips tick when a cycle is still in-flight", async () => {
            let resolveSlowCycle!: (value: MonitorCycleResult) => void;

            // First cycle (initial) resolves immediately
            mockRunMonitorCycle.mockResolvedValueOnce(makeCycleResult());

            // Second cycle is slow — controlled via deferred promise
            mockRunMonitorCycle.mockImplementationOnce(() => {
                return new Promise<MonitorCycleResult>((resolve) => {
                    resolveSlowCycle = resolve;
                });
            });

            // Third cycle onwards resolves immediately
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            await startDaemon(db, "testnet", { intervalMs: 5000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Trigger the slow second cycle
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // Advance through several intervals while second cycle is in-flight
            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000);

            // All those ticks should have been skipped — still only 2 calls
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);

            // Now resolve the slow cycle
            resolveSlowCycle(makeCycleResult());
            await vi.advanceTimersByTimeAsync(0); // flush microtasks

            // The next tick should now succeed since cycleInFlight is cleared
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
    // =========================================================================
    // 10. ALERT DISPATCH
    // =========================================================================
    describe("Alert dispatch", () => {
        it("triggers alert dispatch during daemon cycle", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockDeliverPendingAlerts.mockResolvedValue({
                attempted: 2,
                delivered: 2,
                failed: 0,
                errors: [],
            });
            
            await startDaemon(db, "testnet", { intervalMs: 5000 });
            
            expect(mockDeliverPendingAlerts).toHaveBeenCalledTimes(1);
            expect(mockDeliverPendingAlerts).toHaveBeenCalledWith(db, "testnet");
            expect(mockDaemonLogger.info).toHaveBeenCalledWith(
                "Delivery — attempted: 2, delivered: 2, failed: 0",
            );
            
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockDeliverPendingAlerts).toHaveBeenCalledTimes(2);
            expect(mockDeliverPendingAlerts).toHaveBeenLastCalledWith(db, "testnet");
        });

        it("survives and logs if alert dispatch throws unexpectedly", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());
            mockDeliverPendingAlerts.mockRejectedValueOnce(new Error("Dispatcher exploded"));
            
            // startDaemon should not throw, and the cycle should continue
            await expect(startDaemon(db, "testnet", { intervalMs: 5000 })).resolves.not.toThrow();
            
            expect(mockDeliverPendingAlerts).toHaveBeenCalledTimes(1);
            expect(mockDaemonLogger.error).toHaveBeenCalledWith(
                "deliverPendingAlerts threw unexpectedly",
                expect.any(Error),
            );

            // The next interval should still trigger, showing the daemon didn't crash
            await vi.advanceTimersByTimeAsync(5000);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
            expect(mockDeliverPendingAlerts).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // GROUP-LEVEL POLL INTERVAL PRECEDENCE (issue #400)
    // =========================================================================
    describe("Group-level poll interval precedence", () => {
        /**
         * Precedence (lowest → highest):
         *   global --interval  <  per-group default  <  per-contract override
         */

        it("uses the group's poll_interval_seconds when the contract has no per-contract override", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            const groupId = createGroup(db, { name: "team-alpha" });
            setGroupPollInterval(db, groupId, 200);

            insertContract(db, {
                id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
                name: "group-contract-no-override",
                network: "testnet",
            });
            addContractToGroup(db, {
                group_id: groupId,
                contract_id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
            });

            // Global interval is intentionally much larger so it can't be responsible
            // for the 200 000 ms tick.
            await startDaemon(db, "testnet", { intervalMs: 900_000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(199_999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("per-contract override always wins over the group's default interval", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            const groupId = createGroup(db, { name: "team-beta" });
            setGroupPollInterval(db, groupId, 600);

            insertContract(db, {
                id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O",
                name: "group-contract-with-override",
                network: "testnet",
                poll_interval_seconds: 120,
            });
            addContractToGroup(db, {
                group_id: groupId,
                contract_id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O",
            });

            await startDaemon(db, "testnet", { intervalMs: 900_000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(119_999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // Exactly at 120 s — per-contract override fires (not the 600 s group default).
            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("falls back to global interval when no per-contract override and no group membership", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            insertContract(db, {
                id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
                name: "ungrouped-no-override",
                network: "testnet",
            });

            await startDaemon(db, "testnet", { intervalMs: 10_000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(9_999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("when multiple contracts exist, picks the smallest effective interval across all of them", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            const groupA = createGroup(db, { name: "group-a" });
            setGroupPollInterval(db, groupA, 400);
            const groupB = createGroup(db, { name: "group-b" });
            setGroupPollInterval(db, groupB, 250);

            insertContract(db, {
                id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
                name: "c1-group-a",
                network: "testnet",
            });
            addContractToGroup(db, { group_id: groupA, contract_id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6" });

            insertContract(db, {
                id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O",
                name: "c2-group-b",
                network: "testnet",
            });
            addContractToGroup(db, { group_id: groupB, contract_id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O" });

            // Global fallback is much larger — should not win.
            await startDaemon(db, "testnet", { intervalMs: 900_000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(249_999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            // At 250 s — the smallest group default fires.
            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });

        it("ignores a group with no poll_interval_seconds set (falls back to global)", async () => {
            mockRunMonitorCycle.mockResolvedValue(makeCycleResult());

            const groupId = createGroup(db, { name: "group-no-interval" });

            insertContract(db, {
                id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
                name: "contract-group-no-interval",
                network: "testnet",
            });
            addContractToGroup(db, {
                group_id: groupId,
                contract_id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
            });

            // Global is 10 s; group has no poll_interval_seconds → must fall back to 10 s.
            await startDaemon(db, "testnet", { intervalMs: 10_000 });
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(9_999);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockRunMonitorCycle).toHaveBeenCalledTimes(2);
        });
    });
});
