/**
 * Tests for the Soroban rent cost projection model (Issue #168).
 *
 * Rent formula (from stellar/rs-soroban-env src/fees.rs):
 *
 *   rent_fee_stroops = ceil(
 *     entry_size_bytes × fee_per_rent_1kb × rent_ledgers
 *     / (1024 × rent_rate_denominator)
 *   )
 *
 * For projections we integrate this over a time window expressed in days,
 * converting days → ledger counts via the 5.5-second average close time.
 *
 * Code entries receive a 1/3 discount (CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3).
 */

import { describe, it, expect } from "vitest";
import {
    projectRentCost,
    projectRentWindows,
    RentProjectionInput,
    RentProjectionResult,
    RentWindowProjection,
    LEDGERS_PER_DAY,
    DEFAULT_FEE_PER_RENT_1KB,
    DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
    DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR,
    STROOPS_PER_XLM,
} from "../../src/core/rent_projection";

// ─── Constants verification ────────────────────────────────────────────────

describe("module constants", () => {
    it("LEDGERS_PER_DAY is derived from 5.5s average close time", () => {
        // 86400 seconds/day ÷ 5.5 seconds/ledger ≈ 15709.09…
        expect(LEDGERS_PER_DAY).toBeCloseTo(86400 / 5.5, 0);
    });

    it("STROOPS_PER_XLM is 10_000_000", () => {
        expect(STROOPS_PER_XLM).toBe(10_000_000);
    });

    it("DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR is a positive integer", () => {
        expect(DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR).toBeGreaterThan(0);
        expect(Number.isInteger(DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR)).toBe(true);
    });

    it("DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR is a positive integer", () => {
        expect(DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR).toBeGreaterThan(0);
        expect(Number.isInteger(DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR)).toBe(true);
    });

    it("DEFAULT_FEE_PER_RENT_1KB is a positive integer (stroops)", () => {
        expect(DEFAULT_FEE_PER_RENT_1KB).toBeGreaterThan(0);
        expect(Number.isInteger(DEFAULT_FEE_PER_RENT_1KB)).toBe(true);
    });
});

// ─── projectRentCost — core math ──────────────────────────────────────────

describe("projectRentCost", () => {
    const baseInput: RentProjectionInput = {
        entrySizeBytes: 1024,          // 1 KB for easy math
        days: 30,
        feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB,
        rentRateDenominator: DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
        isPersistent: true,
    };

    it("returns a RentProjectionResult with the expected shape", () => {
        const result = projectRentCost(baseInput);

        expect(result).toHaveProperty("days");
        expect(result).toHaveProperty("ledgerCount");
        expect(result).toHaveProperty("estimatedFeeStroops");
        expect(result).toHaveProperty("estimatedFeeXlm");
    });

    it("ledgerCount matches days × LEDGERS_PER_DAY", () => {
        const result = projectRentCost(baseInput);
        expect(result.ledgerCount).toBeCloseTo(30 * LEDGERS_PER_DAY, 0);
    });

    it("estimatedFeeXlm equals estimatedFeeStroops / STROOPS_PER_XLM", () => {
        const result = projectRentCost(baseInput);
        expect(result.estimatedFeeXlm).toBeCloseTo(
            result.estimatedFeeStroops / STROOPS_PER_XLM,
            7,
        );
    });

    it("fee scales linearly with entry size", () => {
        const small = projectRentCost({ ...baseInput, entrySizeBytes: 1024 });
        const large = projectRentCost({ ...baseInput, entrySizeBytes: 2048 });
        // 2× size → ~2× fee (±1 stroop ceiling tolerance)
        expect(Math.abs(large.estimatedFeeStroops - small.estimatedFeeStroops * 2)).toBeLessThanOrEqual(1);
    });

    it("fee scales linearly with duration", () => {
        const thirty = projectRentCost({ ...baseInput, days: 30 });
        const sixty = projectRentCost({ ...baseInput, days: 60 });
        // 2× days → ~2× fee (±1 stroop ceiling tolerance)
        expect(Math.abs(sixty.estimatedFeeStroops - thirty.estimatedFeeStroops * 2)).toBeLessThanOrEqual(2);
    });

    it("fee scales linearly with feePerRent1kb", () => {
        const low  = projectRentCost({ ...baseInput, feePerRent1kb: 1000 });
        const high = projectRentCost({ ...baseInput, feePerRent1kb: 2000 });
        // 2× fee rate → ~2× fee (±1 stroop ceiling tolerance)
        expect(Math.abs(high.estimatedFeeStroops - low.estimatedFeeStroops * 2)).toBeLessThanOrEqual(1);
    });

    it("matches the canonical formula for 1KB / 30 days exactly (computed by hand)", () => {
        // rent_stroops = ceil( 1024 × feePerRent1kb × ledgers / (1024 × denominator) )
        //              = ceil( feePerRent1kb × ledgers / denominator )
        const ledgers = Math.round(30 * LEDGERS_PER_DAY);
        const expected = Math.ceil(
            (1024 * DEFAULT_FEE_PER_RENT_1KB * ledgers) /
            (1024 * DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR),
        );
        const result = projectRentCost({ ...baseInput, days: 30 });
        expect(result.estimatedFeeStroops).toBe(expected);
    });

    it("applies the CODE_ENTRY_RENT_DISCOUNT_FACTOR=3 for code entries", () => {
        const nonCode = projectRentCost({ ...baseInput, isCodeEntry: false });
        const code    = projectRentCost({ ...baseInput, isCodeEntry: true });
        // Code discount: fee = ceil(full_fee / 3)
        expect(code.estimatedFeeStroops).toBe(
            Math.ceil(nonCode.estimatedFeeStroops / 3),
        );
    });

    it("uses persistent denominator when isPersistent=true (no explicit denominator)", () => {
        // Call without an explicit rentRateDenominator so the function resolves it from isPersistent.
        const { rentRateDenominator: _drop, ...baseNoExplicitDenom } = baseInput as RentProjectionInput & { rentRateDenominator?: number };
        const persistent = projectRentCost({ ...baseNoExplicitDenom, isPersistent: true, rentRateDenominator: undefined });
        const temporary  = projectRentCost({ ...baseNoExplicitDenom, isPersistent: false, rentRateDenominator: undefined });
        // The two denominators differ, so the fees should be different.
        if (DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR !== DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR) {
            expect(persistent.estimatedFeeStroops).not.toBe(temporary.estimatedFeeStroops);
        }
    });

    it("returns the correct days value in the result", () => {
        const result = projectRentCost({ ...baseInput, days: 60 });
        expect(result.days).toBe(60);
    });
});

// ─── projectRentWindows — 30/60/90 day windows ────────────────────────────

describe("projectRentWindows", () => {
    const baseInput: Omit<RentProjectionInput, "days"> = {
        entrySizeBytes: 4096,
        feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB,
        rentRateDenominator: DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
        isPersistent: true,
    };

    it("returns projections for all three windows: 30, 60, and 90 days", () => {
        const result = projectRentWindows(baseInput);

        expect(result.windows).toHaveLength(3);
        expect(result.windows.map(w => w.days)).toEqual([30, 60, 90]);
    });

    it("result includes the input parameters used", () => {
        const result = projectRentWindows(baseInput);
        expect(result.entrySizeBytes).toBe(4096);
        expect(result.feePerRent1kb).toBe(DEFAULT_FEE_PER_RENT_1KB);
    });

    it("60-day projection is approximately double the 30-day projection", () => {
        const result = projectRentWindows(baseInput);
        const [w30, w60] = result.windows as [RentWindowProjection, RentWindowProjection, RentWindowProjection];
        // Allow ±2 stroop tolerance due to independent ceiling operations per window
        expect(Math.abs(w60.estimatedFeeStroops - w30.estimatedFeeStroops * 2)).toBeLessThanOrEqual(2);
    });

    it("90-day projection is approximately triple the 30-day projection", () => {
        const result = projectRentWindows(baseInput);
        const [w30, , w90] = result.windows as [RentWindowProjection, RentWindowProjection, RentWindowProjection];
        // Allow ±3 stroop tolerance due to independent ceiling operations per window
        expect(Math.abs(w90.estimatedFeeStroops - w30.estimatedFeeStroops * 3)).toBeLessThanOrEqual(3);
    });

    it("fees increase monotonically across windows", () => {
        const result = projectRentWindows(baseInput);
        const [w30, w60, w90] = result.windows as [RentWindowProjection, RentWindowProjection, RentWindowProjection];
        expect(w60.estimatedFeeStroops).toBeGreaterThan(w30.estimatedFeeStroops);
        expect(w90.estimatedFeeStroops).toBeGreaterThan(w60.estimatedFeeStroops);
    });

    it("each window result includes estimatedFeeXlm > 0 for non-zero inputs", () => {
        const result = projectRentWindows(baseInput);
        for (const w of result.windows) {
            expect(w.estimatedFeeXlm).toBeGreaterThan(0);
        }
    });

    it("accepts an optional custom feePerRent1kb override", () => {
        const defaultResult = projectRentWindows(baseInput);
        const higherFeeResult = projectRentWindows({
            ...baseInput,
            feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB * 2,
        });
        const [d30] = defaultResult.windows as [RentWindowProjection];
        const [h30] = higherFeeResult.windows as [RentWindowProjection];
        // Allow ±2 stroop tolerance for ceiling arithmetic
        expect(Math.abs(h30.estimatedFeeStroops - d30.estimatedFeeStroops * 2)).toBeLessThanOrEqual(2);
    });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
    const validBase: RentProjectionInput = {
        entrySizeBytes: 1024,
        days: 30,
        feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB,
        rentRateDenominator: DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
        isPersistent: true,
    };

    it("zero bytes → zero fee", () => {
        const result = projectRentCost({ ...validBase, entrySizeBytes: 0 });
        expect(result.estimatedFeeStroops).toBe(0);
        expect(result.estimatedFeeXlm).toBe(0);
    });

    it("zero fee rate → zero fee", () => {
        const result = projectRentCost({ ...validBase, feePerRent1kb: 0 });
        expect(result.estimatedFeeStroops).toBe(0);
        expect(result.estimatedFeeXlm).toBe(0);
    });

    it("zero days → zero fee", () => {
        const result = projectRentCost({ ...validBase, days: 0 });
        expect(result.estimatedFeeStroops).toBe(0);
        expect(result.estimatedFeeXlm).toBe(0);
    });

    it("very large entry size does not produce NaN or Infinity", () => {
        // 100 MB entry
        const result = projectRentCost({ ...validBase, entrySizeBytes: 100 * 1024 * 1024 });
        expect(Number.isFinite(result.estimatedFeeStroops)).toBe(true);
        expect(Number.isNaN(result.estimatedFeeStroops)).toBe(false);
    });

    it("max realistic fee rate (10× default) produces a finite result", () => {
        const result = projectRentCost({
            ...validBase,
            feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB * 10,
        });
        expect(Number.isFinite(result.estimatedFeeStroops)).toBe(true);
    });

    it("very large number of days (e.g. 3650 = ~10 years) produces finite result", () => {
        const result = projectRentCost({ ...validBase, days: 3650 });
        expect(Number.isFinite(result.estimatedFeeStroops)).toBe(true);
        expect(result.estimatedFeeStroops).toBeGreaterThan(0);
    });

    it("1-byte entry still produces a positive fee (ceil rounds up)", () => {
        const result = projectRentCost({ ...validBase, entrySizeBytes: 1 });
        expect(result.estimatedFeeStroops).toBeGreaterThanOrEqual(1);
    });

    it("projectRentWindows with zero bytes produces all-zero fees", () => {
        const result = projectRentWindows({
            entrySizeBytes: 0,
            feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB,
            rentRateDenominator: DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
            isPersistent: true,
        });
        for (const w of result.windows) {
            expect(w.estimatedFeeStroops).toBe(0);
            expect(w.estimatedFeeXlm).toBe(0);
        }
    });

    it("temporary entries use temporary denominator when isPersistent=false", () => {
        const persistent = projectRentCost({ ...validBase, isPersistent: true });
        const temporary  = projectRentCost({
            ...validBase,
            isPersistent: false,
            rentRateDenominator: DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR,
        });
        // Temporary entries are cheaper per ledger — temporary denominator is larger
        if (DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR > DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR) {
            expect(temporary.estimatedFeeStroops).toBeLessThanOrEqual(
                persistent.estimatedFeeStroops,
            );
        }
    });
});

// ─── Concrete numeric spot-checks ─────────────────────────────────────────

describe("concrete numeric verification", () => {
    /**
     * Spot-check the formula against manually computed values.
     *
     * Formula:
     *   ledgers = ceil(days × 86400 / 5.5)
     *   stroops = ceil( sizeBytes × feePerRent1kb × ledgers / (1024 × denominator) )
     *   xlm     = stroops / 10_000_000
     */

    it("1 KB entry, 30 days, fee=1000 stroops/1kb, denominator=2103", () => {
        const ledgers = Math.ceil(30 * 86400 / 5.5);
        const expected = Math.ceil((1024 * 1000 * ledgers) / (1024 * 2103));
        const result = projectRentCost({
            entrySizeBytes: 1024,
            days: 30,
            feePerRent1kb: 1000,
            rentRateDenominator: 2103,
            isPersistent: true,
        });
        expect(result.estimatedFeeStroops).toBe(expected);
    });

    it("4 KB entry, 60 days, fee=500 stroops/1kb, denominator=1000", () => {
        const ledgers = Math.ceil(60 * 86400 / 5.5);
        const expected = Math.ceil((4096 * 500 * ledgers) / (1024 * 1000));
        const result = projectRentCost({
            entrySizeBytes: 4096,
            days: 60,
            feePerRent1kb: 500,
            rentRateDenominator: 1000,
            isPersistent: true,
        });
        expect(result.estimatedFeeStroops).toBe(expected);
    });

    it("10 KB code entry (discount applied), 90 days", () => {
        const ledgers = Math.ceil(90 * 86400 / 5.5);
        const full    = Math.ceil((10 * 1024 * DEFAULT_FEE_PER_RENT_1KB * ledgers) / (1024 * DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR));
        const expected = Math.ceil(full / 3); // CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3
        const result = projectRentCost({
            entrySizeBytes: 10 * 1024,
            days: 90,
            feePerRent1kb: DEFAULT_FEE_PER_RENT_1KB,
            rentRateDenominator: DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR,
            isPersistent: true,
            isCodeEntry: true,
        });
        expect(result.estimatedFeeStroops).toBe(expected);
    });
});
