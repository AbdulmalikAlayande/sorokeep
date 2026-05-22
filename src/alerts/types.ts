import { formatTimeToCloseLedger } from "../utils/formatting.js";

// ─── Core event type ─────────────────────────────────────────────────────────

export interface AlertEvent {
    /** Whether this is a new threshold crossing or a resolved alert. */
    type: "threshold_crossed" | "alert_resolved";
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