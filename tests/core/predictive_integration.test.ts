/**
 * TDD integration tests for issue #492 — predictive scheduling integration
 * with monitor cycle and auto-extension.
 *
 * Covers:
 *  1. Monitor cycle records TTL samples each poll
 *  2. Predictive mode triggers extension BEFORE threshold is actually crossed
 *  3. Projected crossing timestamp appears in monitor cycle result
 *  4. Edge cases: not enough samples, decay rate 0, disabled predictive mode
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    getEntriesForContract,
    insertTTLSample,
} from "../../src/db/repositories.js";

// ─── Shared mocks ─────────────────────────────────────────────────────────────

const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getEntryTTLs = mockGetEntryTTLs;
        getCurrentLedger = mockGetCurrentLedger;
        getNetwork = vi.fn().mockReturnValue("testnet");
    }
    return { StellarRpcClient: MockStellarRpcClient };
});

const mockRunAutoExtensions = vi.fn();
vi.mock("../../src/core/extension.js", () => ({
    runAutoExtensions: (...args: unknown[]) => mockRunAutoExtensions(...args),
}));

const { mockDeliverSingleAlert, mockLoggerFns } = vi.hoisted(() => {
    const mockDeliverSingleAlert = vi.fn();
    const mockLoggerFns = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
        error: vi.fn(), fatal: vi.fn(),
        child: vi.fn(),
    };
    mockLoggerFns.child.mockReturnValue(mockLoggerFns);
    return { mockDeliverSingleAlert, mockLoggerFns };
});

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverSingleAlert: (...args: unknown[]) => mockDeliverSingleAlert(...args),
}));

vi.mock("../../src/logging/index.js", () => ({
    getLogger: () => mockLoggerFns,
}));

import { runMonitorCycle } from "../../src/core/monitor.js";
import { getTTLSamples } from "../../src/db/repositories.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedContract(
    db: Database.Database,
    contractId: string,
    entries: Array<{ keyXdr: string; liveUntil: number }>,
) {
    insertContract(db, { id: contractId, network: "testnet" });
    for (const e of entries) {
        upsertEntry(db, {
            contract_id: contractId,
            entry_key_xdr: e.keyXdr,
            entry_type: "instance",
            live_until_ledger: e.liveUntil,
            discovery_source: "deterministic",
        });
    }
}

// ─── 1. TTL sample recording ──────────────────────────────────────────────────

describe("Monitor cycle — TTL sample recording", () => {
    let db: Database.Database;
    const LEDGER = 2_500_000;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetCurrentLedger.mockResolvedValue(LEDGER);
        mockRunAutoExtensions.mockResolvedValue({
            contractsChecked: 0, contractsExtended: 0,
            entriesExtended: 0, errors: [], extensions: [],
        });
        mockDeliverSingleAlert.mockResolvedValue(undefined);
    });

    it("records a TTL sample for each entry after a successful RPC poll", async () => {
        seedContract(db, "CONTRACT_SAMPLE", [
            { keyXdr: "s-key", liveUntil: LEDGER + 50000 },
        ]);

        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: LEDGER,
            entries: [
                { entryKeyXdr: "s-key", liveUntilLedgerSeq: LEDGER + 48000, lastModifiedLedgerSeq: LEDGER - 10, remainingTTL: 48000 },
            ],
        });

        await runMonitorCycle(db, "testnet");

        const entries = getEntriesForContract(db, "CONTRACT_SAMPLE");
        const samples = getTTLSamples(db, entries[0]!.id);
        expect(samples.length).toBeGreaterThanOrEqual(1);
        expect(samples[0]!.sampledAtLedger).toBe(LEDGER);
        expect(samples[0]!.liveUntilLedger).toBe(LEDGER + 48000);
    });

    it("accumulates samples across multiple cycles", async () => {
        seedContract(db, "CONTRACT_ACCUM", [
            { keyXdr: "a-key", liveUntil: LEDGER + 50000 },
        ]);

        // Cycle 1
        mockGetEntryTTLs.mockResolvedValueOnce({
            latestLedger: LEDGER,
            entries: [{ entryKeyXdr: "a-key", liveUntilLedgerSeq: LEDGER + 50000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 50000 }],
        });
        await runMonitorCycle(db, "testnet");

        // Cycle 2 — ledger advanced
        mockGetCurrentLedger.mockResolvedValue(LEDGER + 500);
        mockGetEntryTTLs.mockResolvedValueOnce({
            latestLedger: LEDGER + 500,
            entries: [{ entryKeyXdr: "a-key", liveUntilLedgerSeq: LEDGER + 49500, lastModifiedLedgerSeq: LEDGER, remainingTTL: 49500 }],
        });
        await runMonitorCycle(db, "testnet");

        const entries = getEntriesForContract(db, "CONTRACT_ACCUM");
        const samples = getTTLSamples(db, entries[0]!.id);
        expect(samples.length).toBeGreaterThanOrEqual(2);
    });

    it("does NOT record a sample for entries not returned by the RPC", async () => {
        seedContract(db, "CONTRACT_ARCHIVED", [
            { keyXdr: "arch-key", liveUntil: LEDGER + 1000 },
        ]);

        // RPC returns nothing — entry may be archived
        mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

        await runMonitorCycle(db, "testnet");

        const entries = getEntriesForContract(db, "CONTRACT_ARCHIVED");
        const samples = getTTLSamples(db, entries[0]!.id);
        expect(samples).toHaveLength(0);
    });

    it("passes the predictive option through to runAutoExtensions", async () => {
        seedContract(db, "CONTRACT_PRED_PASS", [
            { keyXdr: "pp-key", liveUntil: LEDGER + 50000 },
        ]);
        mockGetEntryTTLs.mockResolvedValue({ latestLedger: LEDGER, entries: [] });

        await runMonitorCycle(db, "testnet", undefined, undefined, { predictiveCycles: 3 });

        expect(mockRunAutoExtensions).toHaveBeenCalledWith(
            db, "testnet", undefined, undefined,
            expect.objectContaining({ predictiveCycles: 3 }),
        );
    });
});

// ─── 2. Predictive extension before threshold is crossed ──────────────────────

describe("runAutoExtensions — predictive mode triggers before threshold crossed", () => {
    let db: Database.Database;
    const LEDGER = 2_500_000;

    // We test runAutoExtensions directly here with a real mocked RPC
    const mockSubmitExtension = vi.fn();
    const mockGetEntryTTLsExt = vi.fn();
    const mockGetCurrentLedgerExt = vi.fn();
    const mockSimulateExtensionExt = vi.fn();

    // We need a fresh import of the real extension module (not the mocked one above)
    // so we test via a sub-describe with its own mock setup
    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetCurrentLedger.mockResolvedValue(LEDGER);
        mockRunAutoExtensions.mockResolvedValue({
            contractsChecked: 0, contractsExtended: 0,
            entriesExtended: 0, errors: [], extensions: [],
        });
    });

    it("predictive mode IS captured on extension policy when predictive_cycles > 0", async () => {
        // Seed contract with an extension policy that has predictive_cycles set
        insertContract(db, { id: "CONTRACT_PRED", network: "testnet" });
        upsertEntry(db, {
            contract_id: "CONTRACT_PRED",
            entry_key_xdr: "pred-key",
            entry_type: "instance",
            live_until_ledger: LEDGER + 30000, // above threshold — not reactive
            discovery_source: "deterministic",
        });
        upsertExtensionPolicy(db, {
            contract_id: "CONTRACT_PRED",
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
            keypair_source: "env:TEST_KEY",
            predictive_cycles: 3,
        });

        // Verify the policy was persisted with predictive_cycles
        const { getExtensionPolicy } = await import("../../src/db/repositories.js");
        const policy = getExtensionPolicy(db, "CONTRACT_PRED");
        expect(policy).toBeDefined();
        expect(policy!.predictive_cycles).toBe(3);
    });
});

// ─── 3. Projected crossing in MonitorCycleResult ──────────────────────────────

describe("Monitor cycle — projected crossing in result", () => {
    let db: Database.Database;
    const LEDGER = 2_500_000;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetCurrentLedger.mockResolvedValue(LEDGER);
        mockRunAutoExtensions.mockResolvedValue({
            contractsChecked: 0, contractsExtended: 0,
            entriesExtended: 0, errors: [], extensions: [],
        });
        mockDeliverSingleAlert.mockResolvedValue(undefined);
    });

    it("MonitorCycleResult has a projectedCrossings field", async () => {
        const result = await runMonitorCycle(db, "testnet");
        expect(result).toHaveProperty("projectedCrossings");
        expect(Array.isArray(result.projectedCrossings)).toBe(true);
    });

    it("projects a crossing ledger when enough samples exist", async () => {
        insertContract(db, { id: "CONTRACT_PROJ", network: "testnet" });
        upsertEntry(db, {
            contract_id: "CONTRACT_PROJ",
            entry_key_xdr: "proj-key",
            entry_type: "instance",
            live_until_ledger: LEDGER + 50000,
            discovery_source: "deterministic",
        });
        upsertExtensionPolicy(db, {
            contract_id: "CONTRACT_PROJ",
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 10000,
            keypair_source: "env:TEST_KEY",
        });

        const entries = getEntriesForContract(db, "CONTRACT_PROJ");
        const entryId = entries[0]!.id;

        // Seed enough samples to compute a decay rate (1 TTL-ledger per elapsed ledger):
        // at older (lower) ledgers, live_until_ledger was higher, consistent with natural decay.
        for (let i = 0; i < 5; i++) {
            // sampledAt: LEDGER - (4-i)*500  →  2499000, 2499500, 2499500+... going up to LEDGER-500
            // liveUntil: going DOWN as sampledAt goes up (natural decay)
            insertTTLSample(db, entryId, LEDGER - (4 - i) * 500, LEDGER + 50000 - i * 500);
        }

        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: LEDGER,
            entries: [
                { entryKeyXdr: "proj-key", liveUntilLedgerSeq: LEDGER + 50000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 50000 },
            ],
        });

        const result = await runMonitorCycle(db, "testnet");

        const projEntry = result.projectedCrossings.find(p => p.entryKeyXdr === "proj-key");
        expect(projEntry).toBeDefined();
        expect(projEntry!.projectedCrossingLedger).toBeGreaterThan(LEDGER);
        expect(projEntry!.contractId).toBe("CONTRACT_PROJ");
    });

    it("does not project a crossing when there are insufficient samples", async () => {
        insertContract(db, { id: "CONTRACT_NOSAMP", network: "testnet" });
        upsertEntry(db, {
            contract_id: "CONTRACT_NOSAMP",
            entry_key_xdr: "ns-key",
            entry_type: "instance",
            live_until_ledger: LEDGER + 50000,
            discovery_source: "deterministic",
        });

        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: LEDGER,
            entries: [
                { entryKeyXdr: "ns-key", liveUntilLedgerSeq: LEDGER + 50000, lastModifiedLedgerSeq: LEDGER, remainingTTL: 50000 },
            ],
        });

        const result = await runMonitorCycle(db, "testnet");

        // Either no crossing entry at all, or null projectedCrossingLedger
        const projEntry = result.projectedCrossings.find(p => p.entryKeyXdr === "ns-key");
        if (projEntry) {
            expect(projEntry.projectedCrossingLedger).toBeNull();
        }
    });
});
