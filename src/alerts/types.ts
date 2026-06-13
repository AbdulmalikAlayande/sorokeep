import { formatTimeToCloseLedger } from "../utils/formatting.js";

// ─── Core event type ─────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertEvent {
    /** Whether this is a new threshold crossing or a resolved alert. */
    type: "threshold_crossed" | "alert_resolved";
    /** Severity based on how close to expiry the entry is. */
    severity: AlertSeverity;
    contractId: string;
    contractName: string | null;
    network: string;
    entry: {
        keyXdr: string;
        type: string;
        label: string | null;
    };
    threshold: {
        /** The ledger count configured in the alert_config. */
        configuredLedgers: number;
        /** Remaining TTL at the moment the alert fired. */
        currentRemainingLedgers: number;
        /** Human-readable time estimate, e.g. "~6h 25m". */
        approximateTimeRemaining: string;
    };
    /** Ledger sequence number at the time of detection. */
    firedAtLedger: number;
    /** ISO 8601 timestamp. */
    timestamp: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute alert severity from remaining TTL.
 * - critical: less than 25% of threshold remaining
 * - warning:  less than threshold (but above 25%)
 * - info:     used for resolution events
 */
export function computeSeverity(remainingTTL: number, thresholdLedgers: number, isResolution: boolean): AlertSeverity {
    if (isResolution) return "info";
    if (remainingTTL <= 0) return "critical";
    if (remainingTTL < thresholdLedgers * 0.25) return "critical";
    return "warning";
}

/**
 * Build an AlertEvent from raw data.  Keeps the assembly logic in one place
 * so both the dispatcher and any future test fixtures share it.
 */
export function buildAlertEvent(opts: {
    type: AlertEvent["type"];
    contractId: string;
    contractName: string | null;
    network: string;
    entryKeyXdr: string;
    entryType: string;
    entryLabel: string | null;
    configuredLedgers: number;
    remainingTTL: number;
    firedAtLedger: number;
}): AlertEvent {
    return {
        type: opts.type,
        severity: computeSeverity(opts.remainingTTL, opts.configuredLedgers, opts.type === "alert_resolved"),
        contractId: opts.contractId,
        contractName: opts.contractName,
        network: opts.network,
        entry: {
            keyXdr: opts.entryKeyXdr,
            type: opts.entryType,
            label: opts.entryLabel,
        },
        threshold: {
            configuredLedgers: opts.configuredLedgers,
            currentRemainingLedgers: opts.remainingTTL,
            approximateTimeRemaining: formatTimeToCloseLedger(opts.remainingTTL),
        },
        firedAtLedger: opts.firedAtLedger,
        timestamp: new Date().toISOString(),
    };
}
