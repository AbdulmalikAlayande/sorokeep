import { formatTimeToCloseLedger } from "../utils/formatting.js";

// ─── Core event type ─────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertEventType = "threshold_crossed" | "alert_resolved" | "resource_alert";

// ─── TTL-based alert event ──────────────────────────────────────────────────

export interface TTLAlertEvent {
    type: "threshold_crossed" | "alert_resolved";
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

// ─── Resource-based alert event ─────────────────────────────────────────────

export interface ResourceAlertEvent {
    type: "resource_alert";
    severity: AlertSeverity;
    contractId: string;
    contractName: string | null;
    network: string;
    resource: {
        type: "cpu" | "memory";
        /** Current usage (in instructions or bytes). */
        currentUsage: number;
        /** Configured limit (in instructions or bytes). */
        limit: number;
        /** Usage as a percentage of limit. */
        usagePercent: number;
    };
    /** Human-readable message about the resource usage. */
    message: string;
    /** Ledger sequence number at the time of detection (if available). */
    firedAtLedger?: number;
    /** ISO 8601 timestamp. */
    timestamp: string;
}

// ─── Union of all alert event types ──────────────────────────────────────────

export type AlertEvent = TTLAlertEvent | ResourceAlertEvent;

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
 * Compute alert severity from resource usage percentage.
 * - critical: 95% or higher
 * - warning:  80-95%
 * - info:     not used for resource alerts
 */
export function computeResourceSeverity(usagePercent: number): AlertSeverity {
    if (usagePercent >= 95) return "critical";
    if (usagePercent >= 80) return "warning";
    return "info";
}

/**
 * Build a TTL-based AlertEvent from raw data.
 */
export function buildAlertEvent(opts: {
    type: "threshold_crossed" | "alert_resolved";
    contractId: string;
    contractName: string | null;
    network: string;
    entryKeyXdr: string;
    entryType: string;
    entryLabel: string | null;
    configuredLedgers: number;
    remainingTTL: number;
    firedAtLedger: number;
}): TTLAlertEvent {
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

/**
 * Build a resource-based AlertEvent from raw data.
 */
export function buildResourceAlertEvent(opts: {
    contractId: string;
    contractName: string | null;
    network: string;
    resourceType: "cpu" | "memory";
    currentUsage: number;
    limit: number;
    usagePercent: number;
    firedAtLedger?: number;
}): ResourceAlertEvent {
    const resourceLabel = opts.resourceType === "cpu" ? "CPU" : "Memory";
    const usageUnit = opts.resourceType === "cpu" ? "instructions" : "bytes";
    
    let message = `${resourceLabel} usage is at ${opts.usagePercent}% of limit`;
    if (opts.usagePercent > 100) {
        message = `${resourceLabel} usage exceeds limit: ${opts.currentUsage} ${usageUnit} / ${opts.limit} ${usageUnit}`;
    }

    return {
        type: "resource_alert",
        severity: computeResourceSeverity(opts.usagePercent),
        contractId: opts.contractId,
        contractName: opts.contractName,
        network: opts.network,
        resource: {
            type: opts.resourceType,
            currentUsage: opts.currentUsage,
            limit: opts.limit,
            usagePercent: opts.usagePercent,
        },
        message,
        firedAtLedger: opts.firedAtLedger,
        timestamp: new Date().toISOString(),
    };
}
