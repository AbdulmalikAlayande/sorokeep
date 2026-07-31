import { describe, it, expect } from "vitest";
import {
    computeSmartTargetTtl,
    groupEntriesBySmartTargetTtl,
    DEFAULT_SMART_TTL_BOUNDS,
    type SmartTtlBounds,
} from "../../src/core/extension.js";

const BASELINE = 100_000;

const BOUNDS: SmartTtlBounds = {
    floorLedgers: 17_280,
    ceilingLedgers: 500_000,
    hotThresholdLedgers: 17_280,
    coldThresholdLedgers: 259_200,
};

describe("computeSmartTargetTtl", () => {
    it("resolves a cold entry (no last_modified_ledger change for a long time) to a higher target than the baseline", () => {
        const currentLedger = 1_000_000;
        const lastModifiedLedger = currentLedger - BOUNDS.coldThresholdLedgers; // maximally stale

        const result = computeSmartTargetTtl(BASELINE, lastModifiedLedger, currentLedger, BOUNDS);

        expect(result).toBeGreaterThan(BASELINE);
        expect(result).toBe(BOUNDS.ceilingLedgers);
    });

    it("resolves a very cold entry (staleness far beyond the cold threshold) to the ceiling, not unbounded", () => {
        const currentLedger = 10_000_000;
        const lastModifiedLedger = 0; // enormous staleness

        const result = computeSmartTargetTtl(BASELINE, lastModifiedLedger, currentLedger, BOUNDS);

        expect(result).toBe(BOUNDS.ceilingLedgers);
    });

    it("resolves a hot entry (recently modified) to the baseline, never below the safety floor", () => {
        const currentLedger = 1_000_000;
        const lastModifiedLedger = currentLedger - 100; // just modified

        const result = computeSmartTargetTtl(BASELINE, lastModifiedLedger, currentLedger, BOUNDS);

        expect(result).toBe(BASELINE);
        expect(result).toBeGreaterThanOrEqual(BOUNDS.floorLedgers);
    });

    it("never returns below the safety floor even when the baseline itself is below it", () => {
        const lowBaseline = 1_000; // below floorLedgers (17,280)
        const currentLedger = 1_000_000;

        // Hot case
        expect(
            computeSmartTargetTtl(lowBaseline, currentLedger - 10, currentLedger, BOUNDS),
        ).toBeGreaterThanOrEqual(BOUNDS.floorLedgers);

        // Cold case
        expect(
            computeSmartTargetTtl(lowBaseline, 0, currentLedger, BOUNDS),
        ).toBeGreaterThanOrEqual(BOUNDS.floorLedgers);
    });

    it("never returns above the configured ceiling even for an extremely cold entry", () => {
        const currentLedger = 50_000_000;
        const result = computeSmartTargetTtl(BASELINE, 1, currentLedger, BOUNDS);
        expect(result).toBeLessThanOrEqual(BOUNDS.ceilingLedgers);
    });

    it("interpolates linearly between the baseline and the ceiling for intermediate staleness", () => {
        const currentLedger = 1_000_000;
        const midStaleness = Math.round((BOUNDS.hotThresholdLedgers + BOUNDS.coldThresholdLedgers) / 2);
        const lastModifiedLedger = currentLedger - midStaleness;

        const result = computeSmartTargetTtl(BASELINE, lastModifiedLedger, currentLedger, BOUNDS);

        // Roughly halfway between baseline and ceiling.
        const expectedMid = BASELINE + (BOUNDS.ceilingLedgers - BASELINE) / 2;
        expect(result).toBeGreaterThan(BASELINE);
        expect(result).toBeLessThan(BOUNDS.ceilingLedgers);
        expect(Math.abs(result - expectedMid)).toBeLessThan(BOUNDS.ceilingLedgers * 0.02);
    });

    it("treats a null last_modified_ledger (no signal) as the baseline rather than assuming maximal coldness", () => {
        const result = computeSmartTargetTtl(BASELINE, null, 1_000_000, BOUNDS);
        expect(result).toBe(BASELINE);
    });

    it("treats an undefined last_modified_ledger the same as null", () => {
        const result = computeSmartTargetTtl(BASELINE, undefined, 1_000_000, BOUNDS);
        expect(result).toBe(BASELINE);
    });

    it("is monotonically non-decreasing as staleness increases (no scoring cliffs)", () => {
        const currentLedger = 2_000_000;
        let prev = -1;
        for (let staleness = 0; staleness <= BOUNDS.coldThresholdLedgers + 50_000; staleness += 10_000) {
            const result = computeSmartTargetTtl(BASELINE, currentLedger - staleness, currentLedger, BOUNDS);
            expect(result).toBeGreaterThanOrEqual(prev);
            prev = result;
        }
    });

    it("handles a currentLedger equal to or before last_modified_ledger without going negative or throwing", () => {
        expect(() => computeSmartTargetTtl(BASELINE, 1_000, 1_000, BOUNDS)).not.toThrow();
        expect(computeSmartTargetTtl(BASELINE, 1_000, 1_000, BOUNDS)).toBe(BASELINE);
        expect(() => computeSmartTargetTtl(BASELINE, 2_000, 1_000, BOUNDS)).not.toThrow();
    });

    it("uses DEFAULT_SMART_TTL_BOUNDS when no bounds are supplied", () => {
        const currentLedger = 1_000_000;
        const coldResult = computeSmartTargetTtl(
            BASELINE,
            currentLedger - DEFAULT_SMART_TTL_BOUNDS.coldThresholdLedgers,
            currentLedger,
        );
        expect(coldResult).toBe(DEFAULT_SMART_TTL_BOUNDS.ceilingLedgers);
    });
});

describe("groupEntriesBySmartTargetTtl", () => {
    it("groups a mix of hot and cold entries into distinct target buckets", () => {
        const currentLedger = 1_000_000;
        const entries = [
            { entry_key_xdr: "hot-1", last_modified_ledger: currentLedger - 100 },
            { entry_key_xdr: "hot-2", last_modified_ledger: currentLedger - 200 },
            { entry_key_xdr: "cold-1", last_modified_ledger: currentLedger - BOUNDS.coldThresholdLedgers },
        ];

        const groups = groupEntriesBySmartTargetTtl(entries, BASELINE, currentLedger, BOUNDS);

        expect(groups.size).toBe(2);
        expect(groups.get(BOUNDS.ceilingLedgers)).toEqual(["cold-1"]);

        // Baseline (rounded to nearest 1000, per the default roundToLedgers) holds both hot entries.
        const hotBucketKey = [...groups.keys()].find((k) => k !== BOUNDS.ceilingLedgers)!;
        expect(groups.get(hotBucketKey)).toEqual(expect.arrayContaining(["hot-1", "hot-2"]));
        expect(groups.get(hotBucketKey)!.length).toBe(2);
    });

    it("returns a single group when every entry resolves to the same target", () => {
        const currentLedger = 1_000_000;
        const entries = [
            { entry_key_xdr: "a", last_modified_ledger: currentLedger - 50 },
            { entry_key_xdr: "b", last_modified_ledger: currentLedger - 60 },
        ];

        const groups = groupEntriesBySmartTargetTtl(entries, BASELINE, currentLedger, BOUNDS);
        expect(groups.size).toBe(1);
    });

    it("handles an empty entry list", () => {
        const groups = groupEntriesBySmartTargetTtl([], BASELINE, 1_000_000, BOUNDS);
        expect(groups.size).toBe(0);
    });

    it("never produces a group target below the safety floor", () => {
        const currentLedger = 1_000_000;
        const entries = [{ entry_key_xdr: "x", last_modified_ledger: currentLedger - 10 }];
        const groups = groupEntriesBySmartTargetTtl(entries, 500 /* below floor */, currentLedger, BOUNDS);

        for (const target of groups.keys()) {
            expect(target).toBeGreaterThanOrEqual(BOUNDS.floorLedgers);
        }
    });
});
