/**
 * TDD tests for issue #492 — predictive TTL extension scheduling.
 *
 * Covers:
 *  1. computeDecayRate — pure math, no DB
 *  2. projectCrossingLedger — pure math, no DB
 *  3. insertTTLSample / getTTLSamples — DB repository functions
 *  4. Edge cases: too few samples, flat TTL, negative decay, large spread
 */

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertEntry, getEntriesForContract } from "../../src/db/repositories.js";
import {
    insertTTLSample,
    getTTLSamples,
    pruneOldTTLSamples,
    MAX_TTL_SAMPLES,
} from "../../src/db/repositories.js";
import {
    computeDecayRate,
    projectCrossingLedger,
} from "../../src/core/predictive.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedEntry(db: Database.Database, contractId: string, keyXdr: string, liveUntil: number): number {
    insertContract(db, { id: contractId, network: "testnet" });
    upsertEntry(db, {
        contract_id: contractId,
        entry_key_xdr: keyXdr,
        entry_type: "instance",
        live_until_ledger: liveUntil,
        discovery_source: "deterministic",
    });
    const entries = getEntriesForContract(db, contractId);
    return entries[0]!.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeDecayRate", () => {
    it("returns null when given fewer than 2 samples", () => {
        expect(computeDecayRate([])).toBeNull();
        expect(computeDecayRate([{ sampledAtLedger: 100, liveUntilLedger: 50000 }])).toBeNull();
    });

    it("computes correct decay rate for two perfectly linear samples", () => {
        // TTL dropped by 1000 over 500 ledgers → 2 TTL-ledgers lost per elapsed ledger
        const samples = [
            { sampledAtLedger: 1000, liveUntilLedger: 60000 },
            { sampledAtLedger: 1500, liveUntilLedger: 59000 },
        ];
        const rate = computeDecayRate(samples);
        expect(rate).not.toBeNull();
        expect(rate!).toBeCloseTo(2.0, 5);
    });

    it("computes decay rate from multiple samples via linear regression", () => {
        // Steady decay of 1 TTL-ledger per elapsed ledger
        const samples = [
            { sampledAtLedger: 1000, liveUntilLedger: 50000 },
            { sampledAtLedger: 1500, liveUntilLedger: 49500 },
            { sampledAtLedger: 2000, liveUntilLedger: 49000 },
            { sampledAtLedger: 2500, liveUntilLedger: 48500 },
        ];
        const rate = computeDecayRate(samples);
        expect(rate).not.toBeNull();
        expect(rate!).toBeCloseTo(1.0, 3);
    });

    it("returns null when all sampled ledgers are identical (no elapsed time)", () => {
        const samples = [
            { sampledAtLedger: 1000, liveUntilLedger: 50000 },
            { sampledAtLedger: 1000, liveUntilLedger: 49000 },
        ];
        expect(computeDecayRate(samples)).toBeNull();
    });

    it("returns 0 for flat TTL (no decay detected)", () => {
        // TTL unchanged across multiple polls — contract gets extended externally
        const samples = [
            { sampledAtLedger: 1000, liveUntilLedger: 50000 },
            { sampledAtLedger: 1500, liveUntilLedger: 50000 },
            { sampledAtLedger: 2000, liveUntilLedger: 50000 },
        ];
        const rate = computeDecayRate(samples);
        expect(rate).not.toBeNull();
        expect(rate!).toBeCloseTo(0, 5);
    });

    it("handles negative computed slope (TTL increased — extension happened mid-window)", () => {
        // An extension bumped the TTL mid-window — slope would be negative.
        // The function should return 0 (clamp at zero) to avoid negative projections.
        const samples = [
            { sampledAtLedger: 1000, liveUntilLedger: 49000 },
            { sampledAtLedger: 1500, liveUntilLedger: 100000 }, // extended
        ];
        const rate = computeDecayRate(samples);
        expect(rate).not.toBeNull();
        expect(rate!).toBeGreaterThanOrEqual(0);
    });

    it("handles large sample windows correctly", () => {
        // 10 samples, 1 TTL-ledger decay per elapsed ledger
        const samples = Array.from({ length: 10 }, (_, i) => ({
            sampledAtLedger: 1000 + i * 500,
            liveUntilLedger: 100000 - i * 500,
        }));
        const rate = computeDecayRate(samples);
        expect(rate).not.toBeNull();
        expect(rate!).toBeCloseTo(1.0, 3);
    });
});

// ─── projectCrossingLedger ────────────────────────────────────────────────────

describe("projectCrossingLedger", () => {
    it("returns null when decayRate is null", () => {
        expect(projectCrossingLedger(null, 50000, 10000, 2000)).toBeNull();
    });

    it("returns null when decayRate is zero (no decay — will never cross)", () => {
        expect(projectCrossingLedger(0, 50000, 10000, 2000)).toBeNull();
    });

    it("projects correct crossing ledger for a simple scenario", () => {
        // current ledger = 2000, current TTL = 50000, threshold = 10000
        // gap to close = 50000 - 10000 = 40000 TTL-ledgers
        // decay rate = 2.0 → 40000 / 2.0 = 20000 elapsed ledgers → crossing at 22000
        const crossing = projectCrossingLedger(2.0, 50000, 10000, 2000);
        expect(crossing).toBe(22000);
    });

    it("returns current ledger when TTL is already below or equal to threshold", () => {
        // remainingTTL (5000) < threshold (10000) → already crossed
        const crossing = projectCrossingLedger(1.0, 5000, 10000, 2000);
        expect(crossing).not.toBeNull();
        // Projected crossing is in the past or now
        expect(crossing!).toBeLessThanOrEqual(2000);
    });

    it("never returns a negative ledger number", () => {
        const crossing = projectCrossingLedger(100.0, 5000, 10000, 2000);
        expect(crossing).not.toBeNull();
        expect(crossing!).toBeGreaterThanOrEqual(0);
    });

    it("handles very slow decay correctly (decay rate < 1)", () => {
        // 0.1 TTL-ledgers lost per elapsed ledger, 40000 to close → 400000 elapsed → crosses at 402000
        const crossing = projectCrossingLedger(0.1, 50000, 10000, 2000);
        expect(crossing).toBe(402000);
    });
});

// ─── DB repository: insertTTLSample / getTTLSamples ──────────────────────────

describe("insertTTLSample and getTTLSamples", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("inserts a sample and retrieves it", () => {
        const entryId = seedEntry(db, "CONTRACT_A", "key-a", 50000);
        insertTTLSample(db, entryId, 1000, 50000);

        const samples = getTTLSamples(db, entryId);
        expect(samples).toHaveLength(1);
        expect(samples[0]!.sampledAtLedger).toBe(1000);
        expect(samples[0]!.liveUntilLedger).toBe(50000);
    });

    it("returns samples in descending ledger order (newest first)", () => {
        const entryId = seedEntry(db, "CONTRACT_B", "key-b", 50000);
        insertTTLSample(db, entryId, 1000, 50000);
        insertTTLSample(db, entryId, 1500, 49500);
        insertTTLSample(db, entryId, 2000, 49000);

        const samples = getTTLSamples(db, entryId);
        expect(samples[0]!.sampledAtLedger).toBe(2000);
        expect(samples[1]!.sampledAtLedger).toBe(1500);
        expect(samples[2]!.sampledAtLedger).toBe(1000);
    });

    it("respects the limit parameter", () => {
        const entryId = seedEntry(db, "CONTRACT_C", "key-c", 50000);
        for (let i = 0; i < 8; i++) {
            insertTTLSample(db, entryId, 1000 + i * 500, 50000 - i * 500);
        }
        const samples = getTTLSamples(db, entryId, 3);
        expect(samples).toHaveLength(3);
    });

    it("returns empty array when no samples exist for an entry", () => {
        const entryId = seedEntry(db, "CONTRACT_D", "key-d", 50000);
        expect(getTTLSamples(db, entryId)).toHaveLength(0);
    });

    it("samples for one entry do not bleed into another entry", () => {
        const entryA = seedEntry(db, "CONTRACT_E1", "key-e1", 50000);
        const entryB = seedEntry(db, "CONTRACT_E2", "key-e2", 60000);

        insertTTLSample(db, entryA, 1000, 50000);
        insertTTLSample(db, entryA, 1500, 49500);

        insertTTLSample(db, entryB, 1000, 60000);

        expect(getTTLSamples(db, entryA)).toHaveLength(2);
        expect(getTTLSamples(db, entryB)).toHaveLength(1);
    });
});

// ─── pruneOldTTLSamples ───────────────────────────────────────────────────────

describe("pruneOldTTLSamples", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("removes samples beyond MAX_TTL_SAMPLES, keeping newest", () => {
        const entryId = seedEntry(db, "CONTRACT_F", "key-f", 50000);
        const total = MAX_TTL_SAMPLES + 5;

        for (let i = 0; i < total; i++) {
            insertTTLSample(db, entryId, 1000 + i * 500, 50000 - i * 100);
        }

        pruneOldTTLSamples(db, entryId);

        const samples = getTTLSamples(db, entryId);
        expect(samples.length).toBeLessThanOrEqual(MAX_TTL_SAMPLES);
    });

    it("does not delete samples when count is within limit", () => {
        const entryId = seedEntry(db, "CONTRACT_G", "key-g", 50000);
        for (let i = 0; i < MAX_TTL_SAMPLES - 2; i++) {
            insertTTLSample(db, entryId, 1000 + i * 500, 50000 - i * 100);
        }

        pruneOldTTLSamples(db, entryId);

        expect(getTTLSamples(db, entryId).length).toBe(MAX_TTL_SAMPLES - 2);
    });

    it("keeps exactly MAX_TTL_SAMPLES newest samples after pruning", () => {
        const entryId = seedEntry(db, "CONTRACT_H", "key-h", 50000);
        const total = MAX_TTL_SAMPLES + 3;

        for (let i = 0; i < total; i++) {
            insertTTLSample(db, entryId, 1000 + i * 500, 50000 - i * 100);
        }

        pruneOldTTLSamples(db, entryId);

        const samples = getTTLSamples(db, entryId);
        expect(samples).toHaveLength(MAX_TTL_SAMPLES);
        // Newest sample should be the last inserted
        expect(samples[0]!.sampledAtLedger).toBe(1000 + (total - 1) * 500);
    });
});
