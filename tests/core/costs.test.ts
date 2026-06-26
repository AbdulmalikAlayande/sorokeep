import { describe, it, expect } from "vitest";
import { calculateFeeAdjustedProjection } from "../../src/core/costs.js";

describe("cost projection helpers", () => {
    it("scales 30-day projections when live base fees rise above the default base fee", () => {
        const projection = calculateFeeAdjustedProjection(1, 10, {
            baseFeeStroops: 200,
            surgePricingMultiplier: 1,
        });

        expect(projection.baseProjectedCostXlm).toBe(3);
        expect(projection.adjustedProjectedCostXlm).toBe(6);
        expect(projection.baseFeeMultiplier).toBe(2);
    });

    it("incorporates surge pricing when fee stats show network pressure", () => {
        const projection = calculateFeeAdjustedProjection(1, 30, {
            baseFeeStroops: 100,
            surgePricingMultiplier: 1.5,
        });

        expect(projection.adjustedProjectedCostXlm).toBe(1.5);
        expect(projection.surgePricingMultiplier).toBe(1.5);
    });

    it("falls back to the historical projection when live fee stats are unavailable", () => {
        const projection = calculateFeeAdjustedProjection(2, 20);

        expect(projection.baseProjectedCostXlm).toBe(3);
        expect(projection.adjustedProjectedCostXlm).toBe(3);
        expect(projection.baseFeeMultiplier).toBe(1);
        expect(projection.surgePricingMultiplier).toBe(1);
    });
});
