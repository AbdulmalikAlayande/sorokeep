import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    recordExtension,
} from "../../src/db/repositories.js";
import { getExtensionCosts, calculateFeeAdjustedProjection, getMultiPeriodCosts } from "../../src/core/costs.js";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

let db: Database.Database;
let entryId: number;

beforeEach(() => {
    db = getDatabaseForTesting();
    insertContract(db, {
        id: CONTRACT_ID,
        name: "sample-contract",
        network: "testnet",
    });
    upsertEntry(db, {
        contract_id: CONTRACT_ID,
        entry_key_xdr: "XDR_KEY_1",
        entry_type: "instance",
        label: "contract-instance",
        live_until_ledger: 1000,
    });
    entryId = getEntriesForContract(db, CONTRACT_ID)[0]!.id;
});

describe("getExtensionCosts", () => {
    it("returns contract_not_found when the contract is not watched", () => {
        const result = getExtensionCosts(db, "C" + "A".repeat(55));

        expect(result).toEqual({
            success: false,
            error: "contract_not_found",
            contractId: "C" + "A".repeat(55),
        });
    });

    it("returns invalid_period when period is not a positive integer", () => {
        const result = getExtensionCosts(db, CONTRACT_ID, { period: 0 });

        expect(result).toEqual({
            success: false,
            error: "invalid_period",
            period: 0,
        });
    });

    it("returns empty summary and message when no extensions exist", () => {
        const result = getExtensionCosts(db, CONTRACT_ID, { period: 30 });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.summary).toEqual({
            totalExtensions: 0,
            totalCostXlm: 0,
        });
        expect(result.data.byEntryType).toEqual({});
        expect(result.data.recentExtensions).toEqual([]);
        expect(result.data.projection).toBeUndefined();
        expect(result.data.message).toBe("No extensions recorded for this period.");
        expect(result.data.period).toEqual({ days: 30, label: "last 30 days" });
    });

    it("returns detailed cost structures and projections for extension history", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-instance",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        });

        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "XDR_KEY_2",
            entry_type: "persistent",
            label: "storage-key",
            live_until_ledger: 2000,
        });
        const persistentEntryId = getEntriesForContract(db, CONTRACT_ID).find(
            (entry) => entry.entry_type === "persistent",
        )!.id;

        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: persistentEntryId,
            old_ttl_ledgers: 2000,
            new_ttl_ledgers: 40000,
            tx_hash: "hash-persistent",
            cost_xlm: 0.25,
            executed_at_ledger: 12346,
        });

        const result = getExtensionCosts(db, CONTRACT_ID, { period: 30 });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.contract).toEqual({
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });
        expect(result.data.summary).toEqual({
            totalExtensions: 2,
            totalCostXlm: 0.75,
        });
        expect(result.data.byEntryType).toEqual({
            instance: { count: 1, costXlm: 0.5 },
            persistent: { count: 1, costXlm: 0.25 },
        });
        expect(result.data.recentExtensions).toHaveLength(2);
        expect(result.data.recentExtensions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entryLabel: "storage-key",
                    entryType: "persistent",
                    oldTtlLedgers: 2000,
                    newTtlLedgers: 40000,
                    costXlm: 0.25,
                    txHash: "hash-persistent",
                    executedAtLedger: 12346,
                }),
                expect.objectContaining({
                    entryLabel: "contract-instance",
                    entryType: "instance",
                    oldTtlLedgers: 1000,
                    newTtlLedgers: 50000,
                    costXlm: 0.5,
                    txHash: "hash-instance",
                    executedAtLedger: 12345,
                }),
            ]),
        );
        expect(result.data.projection).toEqual({
            estimated30DayCostXlm: 0.75,
            basisDays: 30,
            formula: "linear extrapolation from period average",
        });
    });

    it("treats null cost_xlm as zero in totals", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-no-cost",
            executed_at_ledger: 12345,
        });

        const result = getExtensionCosts(db, CONTRACT_ID, { period: 30 });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.summary.totalCostXlm).toBe(0);
        expect(result.data.recentExtensions[0]?.costXlm).toBeNull();
    });

    it("defaults period to 30 days when not provided", () => {
        const result = getExtensionCosts(db, CONTRACT_ID);

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.period).toEqual({ days: 30, label: "last 30 days" });
    });
});

describe("getMultiPeriodCosts", () => {
    it("returns contract_not_found for unknown contract", () => {
        const result = getMultiPeriodCosts(db, "C" + "A".repeat(55));
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe("contract_not_found");
        }
    });

    it("returns zero-cost periods when no extensions exist", () => {
        const result = getMultiPeriodCosts(db, CONTRACT_ID);
        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.periods).toHaveLength(3);
        expect(result.data.periods.map(p => p.days)).toEqual([7, 30, 90]);
        for (const p of result.data.periods) {
            expect(p.totalExtensions).toBe(0);
            expect(p.totalCostXlm).toBe(0);
        }
    });

    it("returns contract info with the result", () => {
        const result = getMultiPeriodCosts(db, CONTRACT_ID);
        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.contract).toEqual({
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });
    });

    it("accumulates costs across all three periods", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-1",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        });
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 2000,
            new_ttl_ledgers: 60000,
            tx_hash: "hash-2",
            cost_xlm: 0.3,
            executed_at_ledger: 12346,
        });

        const result = getMultiPeriodCosts(db, CONTRACT_ID);
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (const p of result.data.periods) {
            expect(p.totalExtensions).toBe(2);
            expect(p.totalCostXlm).toBeCloseTo(0.8, 7);
        }
    });

    it("includes a 30-day projection based on the 30-day period", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-proj",
            cost_xlm: 1.0,
            executed_at_ledger: 12345,
        });

        const result = getMultiPeriodCosts(db, CONTRACT_ID);
        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.projection).toBeDefined();
        expect(result.data.projection.baseProjectedCostXlm).toBeGreaterThan(0);
        expect(result.data.projection.adjustedProjectedCostXlm).toBeGreaterThan(0);
    });

    it("applies fee stats to projection when provided", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-fee",
            cost_xlm: 1.0,
            executed_at_ledger: 12345,
        });

        const withoutFees = getMultiPeriodCosts(db, CONTRACT_ID);
        const withFees = getMultiPeriodCosts(db, CONTRACT_ID, {
            baseFeeStroops: 200,
            surgePricingMultiplier: 1.5,
        });

        expect(withoutFees.success).toBe(true);
        expect(withFees.success).toBe(true);
        if (!withoutFees.success || !withFees.success) return;

        expect(withFees.data.projection.adjustedProjectedCostXlm).toBeGreaterThan(
            withoutFees.data.projection.adjustedProjectedCostXlm,
        );
    });

    it("treats null cost_xlm as zero in period totals", () => {
        recordExtension(db, {
            contract_id: CONTRACT_ID,
            contract_entry_id: entryId,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash-null-cost",
            executed_at_ledger: 12345,
        });

        const result = getMultiPeriodCosts(db, CONTRACT_ID);
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (const p of result.data.periods) {
            expect(p.totalExtensions).toBe(1);
            expect(p.totalCostXlm).toBe(0);
        }
    });
});

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
