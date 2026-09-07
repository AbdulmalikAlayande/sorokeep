/**
 * TTL classification + formatting, kept byte-for-byte consistent with sorokeep
 * so the CodeLens status matches the CLI.
 *
 * - Thresholds mirror `classifyTTL` in src/utils/formatting.ts.
 * - Ledger-close time mirrors `AVG_LEDGER_CLOSE_TIME_IN_SECONDS` + `formatTimeToCloseLedger`.
 *
 * The extension reads sorokeep's SQLite directly and duplicates these six or so
 * lines (rather than importing sorokeep's package) to stay a zero-coupling,
 * dependency-light stub. Update this file if the canonical thresholds change.
 */

export type TtlBucket = "expired" | "critical" | "warning" | "ok" | "unknown";

/** Mirrors sorokeep's `classifyTTL` thresholds. */
export const TTL_THRESHOLDS = {
    CRITICAL: 5000,
    WARNING: 20000,
} as const;

/** Mirrors sorokeep's `AVG_LEDGER_CLOSE_TIME_IN_SECONDS`. */
export const AVG_LEDGER_CLOSE_TIME_IN_SECONDS = 5.5;

export function classifyRemainingTTL(remainingLedgers: number): Exclude<TtlBucket, "unknown"> {
    if (remainingLedgers <= 0) return "expired";
    if (remainingLedgers < TTL_THRESHOLDS.CRITICAL) return "critical";
    if (remainingLedgers < TTL_THRESHOLDS.WARNING) return "warning";
    return "ok";
}

/** Human-readable "~Xd Yh" / "~Xh Ym" estimate, matching sorokeep's output. */
export function formatTimeToCloseLedger(ledgers: number): string {
    if (ledgers <= 0) return "Ledger Expired";
    const totalSeconds = ledgers * AVG_LEDGER_CLOSE_TIME_IN_SECONDS;
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `~${days}d ${hours % 24}h`;
    if (hours > 0) return `~${hours}h ${minutes % 60}m`;
    return `~${minutes}m ${totalSeconds % 60}s`;
}

export interface TtlEntryLike {
    label: string | null;
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    status: TtlBucket;
}

export interface ReducedTtl {
    status: TtlBucket;
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    entryLabel: string | null;
}

/**
 * Reduce a contract's entries to a single representative TTL for the CodeLens:
 * the most urgent entry (minimum remaining TTL). Unknown when no entry has a
 * known remaining TTL.
 */
export function reduceContractStatus(entries: TtlEntryLike[]): ReducedTtl {
    const known = entries.filter((e) => e.remainingTTL != null);
    if (known.length === 0) {
        return { status: "unknown", remainingTTL: null, approximateTimeRemaining: null, entryLabel: null };
    }
    const worst = known.reduce((a, b) => (a.remainingTTL! <= b.remainingTTL! ? a : b));
    return {
        status: worst.status,
        remainingTTL: worst.remainingTTL!,
        approximateTimeRemaining: worst.approximateTimeRemaining ?? null,
        entryLabel: worst.label ?? null,
    };
}