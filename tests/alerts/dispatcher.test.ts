import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    insertAlertConfig,
    recordAlertFired,
    MAX_RETRY_COUNT,
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
        channelType?: "webhook" | "slack";
        channelTarget?: string;
        thresholdLedgers?: number;
        ttlAtFire?: number;
        webhookSecret?: string;
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
        webhook_secret: opts.webhookSecret,
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
            expect(result).toHaveProperty("abandoned");
            expect(result).toHaveProperty("errors");
            expect(Array.isArray(result.errors)).toBe(true);
        });

        it("returns zeros when there are no undelivered alerts", async () => {
            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.attempted).toBe(0);
            expect(result.delivered).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.abandoned).toBe(0);
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

        it("calls sendWebhookAlert with the correct URL, event payload, and secret", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CTEST1234",
                contractName: "test-contract",
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
                thresholdLedgers: 15_000,
                ttlAtFire: 7_000,
                webhookSecret: "test-secret-123",
            });

            await deliverPendingAlerts(db, "testnet");

            const [url, event, secret] = mockSendWebhookAlert.mock.calls[0]!;
            expect(url).toBe("https://ops.example.com/hook");
            expect(secret).toBe("test-secret-123");
            expect(event.type).toBe("threshold_crossed");
            expect(event.contractId).toBe("CTEST1234");
            expect(event.contractName).toBe("test-contract");
            expect(event.network).toBe("testnet");
            expect(event.severity).toMatch(/^(warning|critical)$/);
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
                .prepare("SELECT delivered, retry_count FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number; retry_count: number };
            expect(row.delivered).toBe(0);
            expect(row.retry_count).toBe(1);

            // Second cycle — succeeds
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(2);

            row = db
                .prepare("SELECT delivered, retry_count FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number; retry_count: number };
            expect(row.delivered).toBe(1);
        });
    });

    // =========================================================================
    // 4. RETRY LIMITS
    // =========================================================================
    describe("Retry limits", () => {
        it("stops retrying after MAX_RETRY_COUNT failures", async () => {
            mockSendWebhookAlert.mockRejectedValue(new Error("permanent failure"));
            const { alertFiredId } = seedContractWithAlert(db, { contractId: "CA" });

            // Run MAX_RETRY_COUNT cycles — each should attempt delivery
            for (let i = 0; i < MAX_RETRY_COUNT; i++) {
                await deliverPendingAlerts(db, "testnet");
            }

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(MAX_RETRY_COUNT);

            // Next cycle should NOT attempt delivery — alert excluded by retry cap
            await deliverPendingAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(MAX_RETRY_COUNT);

            const row = db
                .prepare("SELECT retry_count, delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { retry_count: number; delivered: number };
            expect(row.retry_count).toBe(MAX_RETRY_COUNT);
            expect(row.delivered).toBe(0);
        });

        it("reports abandoned count in result", async () => {
            mockSendWebhookAlert.mockRejectedValue(new Error("fail"));
            const { alertFiredId } = seedContractWithAlert(db, { contractId: "CA" });

            // Set retry_count to MAX_RETRY_COUNT - 1 so next failure abandons it
            db.prepare("UPDATE alerts_fired SET retry_count = ? WHERE id = ?")
                .run(MAX_RETRY_COUNT - 1, alertFiredId);

            const result = await deliverPendingAlerts(db, "testnet");
            expect(result.abandoned).toBe(1);
        });
    });

    // =========================================================================
    // 5. ERROR RESILIENCE
    // =========================================================================
    describe("Error resilience", () => {
        it("never throws even if all deliveries fail", async () => {
            mockSendWebhookAlert.mockRejectedValue(new Error("all down"));
            seedContractWithAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedContractWithAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            await expect(
                deliverPendingAlerts(db, "testnet"),
            ).resolves.not.toThrow();
        });

        it("continues delivering subsequent alerts even if one fails", async () => {
            mockSendWebhookAlert
                .mockRejectedValueOnce(new Error("first failed"))
                .mockResolvedValue(undefined);

            seedContractWithAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedContractWithAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(2);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(1);
        });

        it("collects error messages for all failed deliveries", async () => {
            mockSendWebhookAlert.mockRejectedValue(new Error("connection timeout"));
            seedContractWithAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedContractWithAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.errors).toHaveLength(2);
            for (const err of result.errors) {
                expect(err).toContain("connection timeout");
            }
        });

        it("handles non-Error exceptions from delivery handlers", async () => {
            mockSendWebhookAlert.mockRejectedValue("string error");
            seedContractWithAlert(db, { contractId: "CA" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.failed).toBe(1);
            expect(result.errors).toHaveLength(1);
        });
    });

    // =========================================================================
    // 6. COUNTING
    // =========================================================================
    describe("Result counting", () => {
        it("counts attempted as total alerts processed regardless of outcome", async () => {
            mockSendWebhookAlert
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error("fail"));

            seedContractWithAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedContractWithAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.attempted).toBe(2);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(1);
        });

        it("counts all successful deliveries across channels", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            mockSendSlackAlert.mockResolvedValue(undefined);

            seedContractWithAlert(db, {
                contractId: "CA",
                entryKeyXdr: "key-a",
                channelType: "webhook",
            });
            seedContractWithAlert(db, {
                contractId: "CB",
                entryKeyXdr: "key-b",
                channelType: "slack",
                channelTarget: "#alerts",
            });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(result.attempted).toBe(2);
            expect(result.delivered).toBe(2);
            expect(result.failed).toBe(0);
        });
    });

    // =========================================================================
    // 7. NETWORK ISOLATION
    // =========================================================================
    describe("Network isolation", () => {
        it("only delivers alerts for the specified network", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, { contractId: "TESTNET_C", network: "testnet" });
            seedContractWithAlert(db, { contractId: "MAINNET_C", network: "mainnet" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            expect(result.attempted).toBe(1);
        });

        it("delivers nothing when no alerts exist for the given network", async () => {
            seedContractWithAlert(db, { contractId: "MAINNET_C", network: "mainnet" });

            const result = await deliverPendingAlerts(db, "testnet");

            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
            expect(result.attempted).toBe(0);
        });
    });

    // =========================================================================
    // 8. PAYLOAD CORRECTNESS
    // =========================================================================
    describe("Payload correctness", () => {
        it("event timestamp is a valid ISO 8601 string", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(() => new Date(event.timestamp)).not.toThrow();
            expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
        });

        it("event entry.keyXdr matches the stored entry_key_xdr", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CA",
                entryKeyXdr: "special-xdr-key",
            });

            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.entry.keyXdr).toBe("special-xdr-key");
        });

        it("event firedAtLedger matches the stored fired_at_ledger", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, {
                contractId: "CA",
            });

            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.firedAtLedger).toBe(2_500_000);
        });

        it("approximateTimeRemaining is a non-empty string", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, { contractId: "CA", ttlAtFire: 50_000 });

            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(typeof event.threshold.approximateTimeRemaining).toBe("string");
            expect(event.threshold.approximateTimeRemaining.length).toBeGreaterThan(0);
        });

        it("event includes severity field", async () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithAlert(db, { contractId: "CA", ttlAtFire: 1_000 });

            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
        });
    });
});
