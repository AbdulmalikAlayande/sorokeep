import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
    buildBudgetExhaustedAlertEvent,
    type BudgetExhaustedAlertEvent,
} from "../../src/alerts/types";

// ─── Hoisted mocks (must be at top, before any imports that trigger side-effects) ─

vi.mock("../../src/rpc/client", () => ({
    StellarRpcClient: vi.fn().mockImplementation(() => ({
        getCurrentLedger: vi.fn().mockResolvedValue(1000),
        simulateExtension: vi.fn().mockResolvedValue({
            success: true,
            minResourceFee: 5_000_000, // 0.5 XLM in stroops
            cpuInstructions: 1000,
            memoryBytes: 500,
            readBytes: 100,
            writeBytes: 50,
        }),
        submitExtension: vi.fn().mockResolvedValue({
            success: true,
            txHash: "TXHASH1",
            ledger: 1001,
            feeCharged: 5_000_000,
            cpuInsns: 1000,
            memBytes: 500,
        }),
        getEntryTTLs: vi.fn().mockResolvedValue({
            latestLedger: 1001,
            entries: [
                {
                    entryKeyXdr: "ENTRYKEY",
                    remainingTTL: 50000,
                    liveUntilLedgerSeq: 51001,
                    lastModifiedLedgerSeq: 1001,
                },
            ],
        }),
    })),
}));

vi.mock("@stellar/stellar-sdk", () => ({
    Keypair: {
        fromSecret: vi.fn().mockReturnValue({
            publicKey: vi.fn().mockReturnValue("GPUBKEYFORTESTING"),
        }),
    },
}));

// Mock the dispatcher so we can spy on deliverSingleAlert without real HTTP calls
const mockDeliverSingleAlert = vi.fn().mockResolvedValue(true);
vi.mock("../../src/alerts/dispatcher", () => ({
    deliverSingleAlert: (...args: unknown[]) => mockDeliverSingleAlert(...args),
    deliverPendingAlerts: vi.fn().mockResolvedValue({ attempted: 0, delivered: 0, failed: 0, abandoned: 0, errors: [] }),
}));

import { runAutoExtensions } from "../../src/core/extension";
import {
    insertContract,
    upsertExtensionPolicy,
    upsertEntry,
    upsertBudget,
    insertAlertConfig,
} from "../../src/db/repositories";

const DUMMY_SECRET = "SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7";

// ─── Unit tests: buildBudgetExhaustedAlertEvent ───────────────────────────────

describe("buildBudgetExhaustedAlertEvent", () => {
    it("returns an event with type 'budget_exhausted' and severity 'critical'", () => {
        const event = buildBudgetExhaustedAlertEvent({
            contractId: "CCONTRACTID001",
            contractName: "My Contract",
            network: "testnet",
            billingCycle: "2026-07",
            limitXlm: 10,
            spentXlm: 9.5,
            estimatedFeeXlm: 1.0,
        });

        expect(event.type).toBe("budget_exhausted");
        expect(event.severity).toBe("critical");
    });

    it("populates all budget sub-fields correctly", () => {
        const event = buildBudgetExhaustedAlertEvent({
            contractId: "CCONTRACTID001",
            contractName: null,
            network: "mainnet",
            billingCycle: "2026-07",
            limitXlm: 5,
            spentXlm: 4.8,
            estimatedFeeXlm: 0.5,
        });

        expect(event.budget.billingCycle).toBe("2026-07");
        expect(event.budget.limitXlm).toBe(5);
        expect(event.budget.spentXlm).toBe(4.8);
        expect(event.budget.estimatedFeeXlm).toBe(0.5);
        expect(event.contractId).toBe("CCONTRACTID001");
        expect(event.contractName).toBeNull();
        expect(event.network).toBe("mainnet");
    });

    it("includes a human-readable message mentioning estimated fee and remaining budget", () => {
        const event = buildBudgetExhaustedAlertEvent({
            contractId: "CCONTRACTID001",
            contractName: null,
            network: "testnet",
            billingCycle: "2026-07",
            limitXlm: 10,
            spentXlm: 9,
            estimatedFeeXlm: 2,
        });

        // remaining = 10 - 9 = 1 XLM; estimated fee = 2 XLM — message should reference both
        expect(event.message).toContain("2.0000000 XLM");  // estimatedFeeXlm
        expect(event.message).toContain("1.0000000 XLM");  // remaining
        expect(event.message).toContain("Auto-extension blocked");
    });

    it("returns a valid ISO 8601 timestamp", () => {
        const before = new Date().toISOString();
        const event = buildBudgetExhaustedAlertEvent({
            contractId: "CCONTRACTID001",
            contractName: null,
            network: "testnet",
            billingCycle: "2026-07",
            limitXlm: 10,
            spentXlm: 9,
            estimatedFeeXlm: 2,
        });
        const after = new Date().toISOString();

        expect(event.timestamp >= before).toBe(true);
        expect(event.timestamp <= after).toBe(true);
    });

    it("conforms to the BudgetExhaustedAlertEvent discriminated union shape", () => {
        const event: BudgetExhaustedAlertEvent = buildBudgetExhaustedAlertEvent({
            contractId: "CCONTRACTID001",
            contractName: "Test",
            network: "testnet",
            billingCycle: "2026-07",
            limitXlm: 10,
            spentXlm: 9,
            estimatedFeeXlm: 2,
        });

        // TypeScript discriminated union narrowing
        if (event.type === "budget_exhausted") {
            expect(event.budget.limitXlm).toBe(10);
        } else {
            throw new Error("type guard should have matched");
        }
    });
});

// ─── Integration tests: budget_exhausted alert fires through runAutoExtensions ─

describe("runAutoExtensions — budget_exhausted alert", () => {
    let db: Database.Database;
    const currentCycle = new Date().toISOString().slice(0, 7);

    beforeEach(() => {
        // Fresh in-memory DB for every test — same pattern as budget_enforcement.test.ts
        db = new Database(":memory:");
        const schema = fs.readFileSync(
            path.resolve(__dirname, "../../src/db/schema.sql"),
            "utf8",
        );
        db.exec(schema);

        insertContract(db, { id: "CONTRACT1", network: "testnet" });
        upsertExtensionPolicy(db, {
            contract_id: "CONTRACT1",
            enabled: true,
            target_ttl_ledgers: 50000,
            extend_when_below_ledgers: 20000,
            keypair_source: DUMMY_SECRET,
        });
        upsertEntry(db, {
            contract_id: "CONTRACT1",
            entry_key_xdr: "ENTRYKEY",
            entry_type: "instance",
            live_until_ledger: 1500, // remaining = 500 < 20000 → triggers extension
        });

        mockDeliverSingleAlert.mockClear();
    });

    it("fires deliverSingleAlert with a budget_exhausted event when spend + fee exceeds limit", async () => {
        // Budget: limit=1 XLM, spent=0.8 XLM. Fee=0.5 XLM → 0.8+0.5 > 1.0 → blocked
        upsertBudget(db, { contract_id: "CONTRACT1", billing_cycle: currentCycle, limit_xlm: 1.0, spent_xlm: 0.8 });

        // Add a webhook alert config so the dispatcher is called
        insertAlertConfig(db, {
            contract_id: "CONTRACT1",
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 20000,
            webhook_secret: null,
        });

        await runAutoExtensions(db, "testnet");

        expect(mockDeliverSingleAlert).toHaveBeenCalledWith(
            "webhook",
            "https://example.com/hook",
            expect.objectContaining({
                type: "budget_exhausted",
                severity: "critical",
                contractId: "CONTRACT1",
            }),
            null,
        );
    });

    it("does NOT fire a budget_exhausted alert when spend is comfortably within budget", async () => {
        // Budget: limit=100 XLM, spent=0.1 XLM. Fee=0.5 XLM → well within budget
        upsertBudget(db, { contract_id: "CONTRACT1", billing_cycle: currentCycle, limit_xlm: 100, spent_xlm: 0.1 });

        insertAlertConfig(db, {
            contract_id: "CONTRACT1",
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 20000,
            webhook_secret: null,
        });

        await runAutoExtensions(db, "testnet");

        const budgetCalls = mockDeliverSingleAlert.mock.calls.filter(
            ([, , event]: any[]) => event?.type === "budget_exhausted",
        );
        expect(budgetCalls).toHaveLength(0);
    });

    it("does NOT fire any alert when no budget is configured for the contract", async () => {
        // No upsertBudget call — contract has no budget limit
        insertAlertConfig(db, {
            contract_id: "CONTRACT1",
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 20000,
            webhook_secret: null,
        });

        await runAutoExtensions(db, "testnet");

        const budgetCalls = mockDeliverSingleAlert.mock.calls.filter(
            ([, , event]: any[]) => event?.type === "budget_exhausted",
        );
        expect(budgetCalls).toHaveLength(0);
    });

    it("continues the extension cycle even when deliverSingleAlert rejects (best-effort)", async () => {
        mockDeliverSingleAlert.mockRejectedValueOnce(new Error("Network error"));

        upsertBudget(db, { contract_id: "CONTRACT1", billing_cycle: currentCycle, limit_xlm: 1.0, spent_xlm: 0.8 });
        insertAlertConfig(db, {
            contract_id: "CONTRACT1",
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 20000,
            webhook_secret: null,
        });

        // runAutoExtensions should NOT throw even though alert delivery rejects
        const result = await runAutoExtensions(db, "testnet");
        // The budget error is still captured in the errors array (extension was blocked)
        expect(result.errors.some(e => e.includes("budget limit exceeded"))).toBe(true);
    });
});
