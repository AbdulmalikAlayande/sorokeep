/**
 * Predictive TTL extension scheduling — issue #492
 *
 * Pure computation functions: no DB, no network, no side-effects.
 * These are deliberately kept small so they're trivially testable.
 */

export interface TTLSample {
    sampledAtLedger: number;
    liveUntilLedger: number;
}

/**
 * Compute a decay rate (TTL-ledgers lost per elapsed ledger) from a series
 * of historical samples using simple linear regression on (sampledAtLedger →
 * liveUntilLedger).
 *
 * The slope of that regression line is the rate at which `liveUntilLedger`
 * changes as `sampledAtLedger` increases.  A healthy contract decays at
 * roughly 1.0 (one TTL ledger consumed per elapsed ledger).
 *
 * Returns:
 *  - `null`  when fewer than 2 samples are provided or all sampled ledgers
 *            are identical (cannot fit a line).
 *  - `0`     when no net decay is detected (slope ≤ 0 after clamping).
 *  - a positive number representing ledgers of TTL lost per elapsed ledger.
 */
export function computeDecayRate(samples: TTLSample[]): number | null {
    if (samples.length < 2) return null;

    const n = samples.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;

    for (const s of samples) {
        sumX  += s.sampledAtLedger;
        sumY  += s.liveUntilLedger;
        sumXX += s.sampledAtLedger * s.sampledAtLedger;
        sumXY += s.sampledAtLedger * s.liveUntilLedger;
    }

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null; // all x values identical

    // slope = Δ(liveUntilLedger) / Δ(sampledAtLedger)
    // A decaying TTL has a negative slope; we want the magnitude.
    const slope = (n * sumXY - sumX * sumY) / denom;

    // Negate: positive decay rate means TTL is shrinking.
    // Clamp at 0 — a net increase (extension mid-window) contributes nothing.
    return Math.max(0, -slope);
}

/**
 * Given a decay rate and current TTL state, project the ledger at which
 * `remainingTTL` will fall below `thresholdLedgers`.
 *
 * Returns:
 *  - `null` when `decayRate` is null or zero (cannot project).
 *  - A non-negative ledger number (clamped at 0) representing when the
 *    threshold will be crossed.
 */
export function projectCrossingLedger(
    decayRate: number | null,
    remainingTTL: number,
    thresholdLedgers: number,
    currentLedger: number,
): number | null {
    if (decayRate === null || decayRate === 0) return null;

    // Ledgers of TTL still above threshold
    const gap = remainingTTL - thresholdLedgers;

    // ledgers of real time until TTL reaches threshold
    const elapsed = gap / decayRate;

    return Math.max(0, Math.round(currentLedger + elapsed));
}
