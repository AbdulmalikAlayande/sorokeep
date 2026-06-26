import type { FeeStatsResult } from "../rpc/client.js";

const DEFAULT_BASE_FEE_STROOPS = 100;

export interface FeeAdjustedProjection {
    baseProjectedCostXlm: number;
    adjustedProjectedCostXlm: number;
    baseFeeMultiplier: number;
    surgePricingMultiplier: number;
}

export function calculateFeeAdjustedProjection(
    totalCostXlm: number,
    periodDays: number,
    feeStats?: Pick<FeeStatsResult, "baseFeeStroops" | "surgePricingMultiplier">,
): FeeAdjustedProjection {
    const baseProjectedCostXlm = (totalCostXlm / periodDays) * 30;
    const liveBaseFee = feeStats?.baseFeeStroops ?? DEFAULT_BASE_FEE_STROOPS;
    const baseFeeMultiplier = Math.max(liveBaseFee / DEFAULT_BASE_FEE_STROOPS, 0);
    const surgePricingMultiplier = Math.max(feeStats?.surgePricingMultiplier ?? 1, 1);

    return {
        baseProjectedCostXlm,
        adjustedProjectedCostXlm: baseProjectedCostXlm * baseFeeMultiplier * surgePricingMultiplier,
        baseFeeMultiplier,
        surgePricingMultiplier,
    };
}
