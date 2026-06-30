import type Database from "better-sqlite3";
import { runMonitorCycle, type MonitorCycleResult } from "../core/monitor.js";
import { runIntrospectionRescan } from "../core/introspection.js";
import { deliverPendingAlerts } from "../alerts/dispatcher.js";
import { vacuumDatabase } from "../db/database.js";
import { aggregateDailyCostSnapshots } from "../db/repositories.js";
import { getLogger } from "../logging/index.js";
import type { Logger } from "../logging/types.js";

// Resolve the child logger lazily so that a runtime reconfiguration of the
// global logger (e.g. the daemon command's `--log-format json`) is in effect
// by the time the loop emits its first line.
let loopLogger: Logger | null = null;
function logger(): Logger {
    return (loopLogger ??= getLogger().child({ component: "DaemonLoop" }));
}

// ─── Public contract ──────────────────────────────────────────────────────────

export interface DaemonOptions {
    /** Polling interval in milliseconds. Defaults to 300000 (5 minutes). */
    intervalMs?: number;
    /** Optional RPC endpoint URL override. */
    rpcUrl?: string;
    /** How frequently to run vacuum maintenance. Defaults to 24 hours. */
    vacuumIntervalMs?: number;
    /** Called after every cycle with the result (or null + error on failure). */
    onCycle?: (result: MonitorCycleResult | null, error?: Error) => void;
}

// ─── Module-level state ───────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;
let vacuumIntervalMs = DEFAULT_VACUUM_INTERVAL_MS;
let lastVacuumAt = 0;

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Start the monitoring daemon.
 *
 * Runs one cycle immediately, then schedules repeating cycles at the
 * configured interval.  Never rejects — errors from individual cycles
 * are caught, logged, and forwarded to the optional `onCycle` callback.
 *
 * Calling `startDaemon` while a daemon is already running will stop the
 * previous loop first (kills the old timer), then start fresh.
 *
 * Re-entrance guard: if a cycle is still in-flight when the next interval
 * fires, that tick is skipped silently.
 */
export async function startDaemon(
    db: Database.Database,
    network: string,
    options?: DaemonOptions,
): Promise<void> {
    // Kill any existing loop before starting a new one.
    stopDaemon();

    const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    vacuumIntervalMs = options?.vacuumIntervalMs ?? DEFAULT_VACUUM_INTERVAL_MS;
    const rpcUrl = options?.rpcUrl;
    const onCycle = options?.onCycle;

    lastVacuumAt = Date.now();
    logger().info(`Daemon starting — network: ${network}, interval: ${intervalMs}ms`);

    // Run the initial cycle immediately.
    await executeCycle(db, network, rpcUrl, onCycle);

    // Schedule repeating cycles.
    intervalHandle = setInterval(() => {
        void scheduledTick(db, network, rpcUrl, onCycle);
    }, intervalMs);
}

/**
 * Stop the monitoring daemon.
 *
 * Clears the interval timer so no further cycles are scheduled.
 * Idempotent — safe to call multiple times or before `startDaemon`.
 * Does NOT abort a cycle that is currently in-flight; it will finish
 * naturally, but no new cycle will be scheduled after it.
 */
export function stopDaemon(): void {
    if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger().info("Daemon stopped");
    }
    cycleInFlight = false;
}

// ─── Private ──────────────────────────────────────────────────────────────────

/**
 * Execute a single monitoring cycle with full error isolation.
 *
 * Sets the `cycleInFlight` flag to prevent re-entrance, runs the cycle,
 * invokes the `onCycle` callback, and guarantees that no thrown error
 * (from the cycle or the callback) can kill the daemon.
 */
async function executeCycle(
    db: Database.Database,
    network: string,
    rpcUrl: string | undefined,
    onCycle: DaemonOptions["onCycle"],
): Promise<void> {
    cycleInFlight = true;

    try {
        const result = await runMonitorCycle(db, network, rpcUrl);

        logger().debug(
            `Cycle complete — checked: ${result.contractsChecked}, ` +
            `updated: ${result.entriesUpdated}, ` +
            `crossed: ${result.thresholdsCrossed}, ` +
            `resolved: ${result.alertsResolved}, ` +
            `extended: ${result.extensionsTriggered}, ` +
            `errors: ${result.errors.length}`,
        );

        // Step 2: deliver any pending alerts that accumulated during detection.
        // Errors here are isolated — they must NOT kill the cycle or surface to onCycle.
        try {
            const delivery = await deliverPendingAlerts(db, network);
            if (delivery.attempted > 0) {
                logger().info(
                    `Delivery — attempted: ${delivery.attempted}, ` +
                    `delivered: ${delivery.delivered}, failed: ${delivery.failed}`,
                );
            }
        } catch (deliveryErr: unknown) {
            // This should never happen (deliverPendingAlerts never throws),
            // but guard defensively.
            logger().error("deliverPendingAlerts threw unexpectedly", deliveryErr);
        }

        // Step 3: Run introspection re-scan
        try {
            const introspection = await runIntrospectionRescan(db, network, rpcUrl);
            if (introspection.contractsChecked > 0) {
                logger().info(
                    `Introspection — checked: ${introspection.contractsChecked}, ` +
                    `new keys: ${introspection.newEntriesFound}, ` +
                    `errors: ${introspection.errors.length}`,
                );
            }
        } catch (introErr: unknown) {
            logger().error("runIntrospectionRescan threw unexpectedly", introErr);
        }

        // Step 4: aggregate daily cost snapshots for past extension history.
        try {
            aggregateDailyCostSnapshots(db);
        } catch (snapshotErr: unknown) {
            logger().error("aggregateDailyCostSnapshots threw unexpectedly", snapshotErr);
        }

        safeOnCycle(onCycle, result, undefined);
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger().error(`Cycle failed: ${error.message}`, err);
        safeOnCycle(onCycle, null, error);
    } finally {
        cycleInFlight = false;
    }
}

async function scheduledTick(
    db: Database.Database,
    network: string,
    rpcUrl: string | undefined,
    onCycle: DaemonOptions["onCycle"],
): Promise<void> {
    if (cycleInFlight) {
        logger().debug("Skipping tick — previous cycle still in flight");
        return;
    }

    await runScheduledVacuum(db);
    await executeCycle(db, network, rpcUrl, onCycle);
}

async function runScheduledVacuum(db: Database.Database): Promise<void> {
    if (Date.now() - lastVacuumAt < vacuumIntervalMs) {
        return;
    }

    if (db.inTransaction) {
        logger().info("Skipping scheduled vacuum — database has an active transaction");
        return;
    }

    logger().info("Scheduled maintenance: starting database vacuum");
    const vacuumed = vacuumDatabase(db);
    if (vacuumed) {
        lastVacuumAt = Date.now();
        logger().info("Scheduled maintenance: database vacuum completed");
    } else {
        logger().info("Scheduled maintenance: database vacuum skipped due to busy database");
    }
}

/**
 * Invoke the onCycle callback without letting it kill the daemon.
 */
function safeOnCycle(
    onCycle: DaemonOptions["onCycle"],
    result: MonitorCycleResult | null,
    error: Error | undefined,
): void {
    if (!onCycle) return;
    try {
        onCycle(result, error);
    } catch (cbErr) {
        logger().error("onCycle callback threw — ignoring", cbErr);
    }
}
