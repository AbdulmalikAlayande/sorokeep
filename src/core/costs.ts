import type Database from "better-sqlite3";
import {
    getContract,
    getEntriesForContract,
    getExtensionHistory,
} from "../db/repositories.js";
import { formatTimeToCloseLedger } from "../utils/formatting.js";
import type { FeeStatsResult } from "../rpc/client.js";

export interface EntryTypeCostBreakdown {
    count: number;
    costXlm: number;
}

export interface ExtensionCostDetail {
    executedAt: string;
    entryLabel: string;
    entryType: string;
    oldTtlLedgers: number;
    newTtlLedgers: number;
    oldTtlFormatted: string;
    newTtlFormatted: string;
    costXlm: number | null;
    txHash: string;
    executedAtLedger: number;
}

export interface CostProjection {
    estimated30DayCostXlm: number;
    basisDays: number;
    formula: string;
}

export interface ExtensionCostsResult {
    contract: {
        id: string;
        name: string | null;
        network: string;
    };
    period: {
        days: number | null;
        label: string;
    };
    summary: {
        totalExtensions: number;
        totalCostXlm: number;
    };
    byEntryType: Record<string, EntryTypeCostBreakdown>;
    recentExtensions: ExtensionCostDetail[];
    projection?: CostProjection;
    message?: string;
}

export type GetExtensionCostsError =
    | { success: false; error: "contract_not_found"; contractId: string }
    | { success: false; error: "invalid_period"; period: number };

export type GetExtensionCostsResponse =
    | { success: true; data: ExtensionCostsResult }
    | GetExtensionCostsError;

const DEFAULT_PERIOD_DAYS = 30;

export function getExtensionCosts(
    db: Database.Database,
    contractId: string,
    options?: { period?: number; all?: boolean },
): GetExtensionCostsResponse {
    const contract = getContract(db, contractId);
    if (!contract) {
        return {
            success: false,
            error: "contract_not_found",
            contractId,
        };
    }

    const allTime = options?.all === true;
    const period = allTime ? undefined : (options?.period ?? DEFAULT_PERIOD_DAYS);
    if (period !== undefined && (!Number.isInteger(period) || period <= 0)) {
        return {
            success: false,
            error: "invalid_period",
            period,
        };
    }

    const history = getExtensionHistory(db, contractId, period);
    const periodLabel = allTime ? "all time" : `last ${period} days`;

    if (history.length === 0) {
        return {
            success: true,
            data: {
                contract: {
                    id: contract.id,
                    name: contract.name,
                    network: contract.network,
                },
                period: {
                    days: period ?? null,
                    label: periodLabel,
                },
                summary: {
                    totalExtensions: 0,
                    totalCostXlm: 0,
                },
                byEntryType: {},
                recentExtensions: [],
                message: "No extensions recorded for this period.",
            },
        };
    }

    const entries = getEntriesForContract(db, contractId);
    const entryMap = new Map(entries.map((entry) => [entry.id, entry]));

    let totalCostXlm = 0;
    const byEntryType: Record<string, EntryTypeCostBreakdown> = {};

    for (const record of history) {
        const cost = record.cost_xlm ?? 0;
        totalCostXlm += cost;

        const entry = entryMap.get(record.contract_entry_id);
        const entryType = entry?.entry_type ?? "unknown";

        if (!byEntryType[entryType]) {
            byEntryType[entryType] = { count: 0, costXlm: 0 };
        }

        byEntryType[entryType]!.count++;
        byEntryType[entryType]!.costXlm += cost;
    }

    const recentExtensions = history.map((record) => {
        const entry = entryMap.get(record.contract_entry_id);
        const entryLabel = entry?.label ?? entry?.entry_type ?? "unknown";
        const entryType = entry?.entry_type ?? "unknown";

        return {
            executedAt: record.executed_at,
            entryLabel,
            entryType,
            oldTtlLedgers: record.old_ttl_ledgers,
            newTtlLedgers: record.new_ttl_ledgers,
            oldTtlFormatted: formatTimeToCloseLedger(record.old_ttl_ledgers),
            newTtlFormatted: formatTimeToCloseLedger(record.new_ttl_ledgers),
            costXlm: record.cost_xlm,
            txHash: record.tx_hash,
            executedAtLedger: record.executed_at_ledger,
        };
    });

    return {
        success: true,
        data: {
            contract: {
                id: contract.id,
                name: contract.name,
                network: contract.network,
            },
            period: {
                days: period ?? null,
                label: periodLabel,
            },
            summary: {
                totalExtensions: history.length,
                totalCostXlm,
            },
            byEntryType,
            recentExtensions,
            ...(period !== undefined
                ? {
                      projection: {
                          estimated30DayCostXlm: (totalCostXlm / period) * 30,
                          basisDays: period,
                          formula: "linear extrapolation from period average",
                      },
                  }
                : {}),
        },
    };
}

const MULTI_PERIOD_WINDOWS = [7, 30, 90] as const;

export interface PeriodCostSummary {
    days: number;
    totalExtensions: number;
    totalCostXlm: number;
}

export interface MultiPeriodCostsData {
    contract: { id: string; name: string | null; network: string };
    periods: PeriodCostSummary[];
    projection: FeeAdjustedProjection;
}

export type GetMultiPeriodCostsResponse =
    | { success: true; data: MultiPeriodCostsData }
    | { success: false; error: "contract_not_found"; contractId: string };

export function getMultiPeriodCosts(
    db: Database.Database,
    contractId: string,
    feeStats?: Pick<FeeStatsResult, "baseFeeStroops" | "surgePricingMultiplier">,
): GetMultiPeriodCostsResponse {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, error: "contract_not_found", contractId };
    }

    const periods: PeriodCostSummary[] = MULTI_PERIOD_WINDOWS.map((days) => {
        const history = getExtensionHistory(db, contractId, days);
        let totalCostXlm = 0;
        for (const record of history) {
            totalCostXlm += record.cost_xlm ?? 0;
        }
        return { days, totalExtensions: history.length, totalCostXlm };
    });

    const thirtyDay = periods.find((p) => p.days === 30)!;
    const projection = calculateFeeAdjustedProjection(thirtyDay.totalCostXlm, 30, feeStats);

    return {
        success: true,
        data: {
            contract: { id: contract.id, name: contract.name, network: contract.network },
            periods,
            projection,
        },
    };
}

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
