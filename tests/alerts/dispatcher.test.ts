import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    insertAlertConfig,
    recordAlertFired,
} from "../../src/db/repositories";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSendWebhookAlert = vi.fn();
const mockSendSlackAlert = vi.fn();

vi.mock("../../src/alerts/webhook.js", () => ({
    sendWebhookAlert: (...args: unknown[]) => mockSendWebhookAlert(...args),
}));

vi.mock("../../src/alerts/slack.js", () => ({
    sendSlackAlert: (...args: unknown[]) => mockSendSlackAlert(...args),
}));

import { deliverPendingAlerts } from "../../src/alerts/dispatcher";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedContractWithAlert(
    db: Database.Database,
    opts: {
        contractId: string;
        contractName?: string;
        network?: string;
        entryKeyXdr?: string;
        entryType?: string;
        channelType?: "webhook" | "slack" | "email";
        channelTarget?: string;
        thresholdLedgers?: number;
        ttlAtFire?: number;
    }
): { entryId: number; alertConfigId: number; alertFiredId: number } {
    const network = opts.network ?? "testnet";
    const entryKeyXdr = opts.entryKeyXdr ?? `key-${opts.contractId}`;

    insertContract(db, {
        id: opts.contractId,
        name: opts.contractName,
        network,
    });
    upsertEntry(db, {
        contract_id: opts.contractId,
        entry_key_xdr: entryKeyXdr,
        entry_type: opts.entryType ?? "instance",
        live_until_ledger: 3_000_000,
        discovery_source: "deterministic",
    });

    const entry = db
        .prepare("SELECT id FROM contract_entries WHERE contract_id = ? AND entry_key_xdr = ?")
        .get(opts.contractId, entryKeyXdr) as { id: number };

    insertAlertConfig(db, {
        contract_id: opts.contractId,
        channel_type: opts.channelType ?? "webhook",
        channel_target: opts.channelTarget ?? "https://example.com/hook",
        threshold_ledgers: opts.thresholdLedgers ?? 20_000,
    });

    const config = db
        .prepare("SELECT id FROM alert_configs WHERE contract_id = ?")
        .get(opts.contractId) as { id: number };

    recordAlertFired(db, {
        alert_config_id: config.id,
        contract_entry_id: entry.id,
        fired_at_ledger: 2_500_000,
        ttl_at_fire: opts.ttlAtFire ?? 8_000,
    });

    const fired = db
        .prepare("SELECT id FROM alerts_fired WHERE alert_config_id = ? AND contract_entry_id = ?")
        .get(config.id, entry.id) as { id: number };

    return { entryId: entry.id, alertConfigId: config.id, alertFiredId: fired.id };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("deliverPendingAlerts", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. RETURN SHAPE
    // =========================================================================
    describe("Return shape", () => {
        it("returns a DeliveryResult with all required fields when nothing to deliver", async () => {
            const result = await deliverPendingAlerts(db, "testnet");

            expect(result).toHaveProperty("attempted");
            expect(result).toHaveProperty("delivered");
            expect(result).toHaveProperty("failed");
            expect(result).toHaveProperty("errors");
            expect(Array.isArray(result.errors)).toBe(true);
        });

        it("returns zeros when there are no undelivered alerts", async () => {
            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.attempted).toBe(0);
            expect(result.delivered).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.errors).toHaveLength(0);
        });
    });

    // =========================================================================
    // 2. CHANNEL ROUTING
    // =========================================================================
    describe("Channel routing", () => {
        it("routes webhook alerts to sendWebhookAlert", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CA",
                channelType: "webhook",
                channelTarget: "https://example.com/hook",
            });

            await deliverPendingAlerts(db, "testnet");

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            expect(mockSendSlackAlert).not.toHaveBeenCalled();
        });

        it("routes slack alerts to sendSlackAlert", async () => {
            mockSendSlackAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CA",
                channelType: "slack",
                channelTarget: "#oncall",
            });

            await deliverPendingAlerts(db, "testnet");

            expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });

        it("calls sendWebhookAlert with the correct URL and event payload", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CTEST1234",
                contractName: "test-contract",
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
                thresholdLedgers: 15_000,
                ttlAtFire: 7_000,
            });

            await deliverPendingAlerts(db, "testnet");

            const [url, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(url).toBe("https://ops.example.com/hook");
            expect(event.type).toBe("threshold_crossed");
            expect(event.contractId).toBe("CTEST1234");
            expect(event.contractName).toBe("test-contract");
            expect(event.network).toBe("testnet");
            expect(event.threshold.configuredLedgers).toBe(15_000);
            expect(event.threshold.currentRemainingLedgers).toBe(7_000);
            expect(typeof event.threshold.approximateTimeRemaining).toBe("string");
            expect(typeof event.timestamp).toBe("string");
        });

        it("calls sendSlackAlert with the correct channel and event", async () => {
            mockSendSlackAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CA",
                channelType: "slack",
                channelTarget: "#my-alerts",
            });

            await deliverPendingAlerts(db, "testnet");

            const [channel, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(channel).toBe("#my-alerts");
            expect(event.type).toBe("threshold_crossed");
        });

        it("does not call any handler for email channel type (not yet implemented)", async () => {
            seedContractWithAlert(db, {
                contractId: "CA",
                channelType: "email",
                channelTarget: "ops@example.com",
            });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
            expect(mockSendSlackAlert).not.toHaveBeenCalled();
            // email should be counted as skipped — not failed, not delivered
            expect(result.attempted).toBe(1);
        });
    });

    // =========================================================================
    // 3. DELIVERED FLAG MANAGEMENT
    // =========================================================================
    describe("Delivered flag management", () => {
        it("marks the alert as delivered in the DB after successful send", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            const { alertFiredId } = seedContractWithAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet");

            const row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(1);
        });

        it("does NOT mark as delivered when send fails", async () => {
            mockSendWebhookAlert.mockRejectedValue(new Error("connection refused"));
            const { alertFiredId } = seedContractWithAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet");

            const row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(0);
        });

        it("does not re-deliver already-delivered alerts", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, { contractId: "CA" });

            // First delivery
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);

            // Second delivery cycle — already marked as delivered
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
        });

        it("retries a failed alert on the next cycle", async () => {
            mockSendWebhookAlert
                .mockRejectedValueOnce(new Error("Slack down"))
                .mockResolvedValue(undefined);

            const { alertFiredId } = seedContractWithAlert(db, { contractId: "CA" });

            // First cycle — fails
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);

            let row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(0);

            // Second cycle — succeeds
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(2);

            row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(1);
        });
    });

    // =========================================================================
    // 4. ERROR RESILIENCE
});