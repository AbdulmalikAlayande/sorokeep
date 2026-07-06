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
import { deliverPendingAlerts } from "../../src/alerts/dispatcher";
import type { AlertChannel } from "../../src/alerts/types";

function mockChannel(): AlertChannel & { send: ReturnType<typeof vi.fn> } {
    return { send: vi.fn().mockResolvedValue(undefined) };
}

function seedAlert(
    db: Database.Database,
    opts: {
        contractId: string;
        contractName?: string;
        network?: string;
        entryKeyXdr?: string;
        entryType?: string;
        channelType?: "webhook" | "slack" | "pagerduty";
        channelTarget?: string;
        thresholdLedgers?: number;
        ttlAtFire?: number;
        webhookSecret?: string;
    },
): { entryId: number; alertConfigId: number; alertFiredId: number } {
    const network = opts.network ?? "testnet";
    const entryKeyXdr = opts.entryKeyXdr ?? `key-${opts.contractId}`;

    insertContract(db, { id: opts.contractId, name: opts.contractName, network });
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

describe("deliverPendingAlerts", () => {
    let db: Database.Database;
    let channels: Record<string, AlertChannel & { send: ReturnType<typeof vi.fn> }>;

    beforeEach(() => {
        db = getDatabaseForTesting();
        channels = {
            webhook: mockChannel(),
            slack: mockChannel(),
            pagerduty: mockChannel(),
        };
    });

    describe("Return shape", () => {
        it("returns a DeliveryResult with all required fields when nothing to deliver", async () => {
            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result).toHaveProperty("attempted");
            expect(result).toHaveProperty("delivered");
            expect(result).toHaveProperty("failed");
            expect(result).toHaveProperty("abandoned");
            expect(result).toHaveProperty("errors");
            expect(Array.isArray(result.errors)).toBe(true);
        });

        it("returns zeros when there are no undelivered alerts", async () => {
            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.attempted).toBe(0);
            expect(result.delivered).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.abandoned).toBe(0);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe("Channel routing", () => {
        it("routes webhook alerts to the webhook channel", async () => {
            seedAlert(db, { contractId: "CA", channelType: "webhook", channelTarget: "https://example.com/hook" });

            await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.webhook.send).toHaveBeenCalledTimes(1);
            expect(channels.slack.send).not.toHaveBeenCalled();
        });

        it("routes slack alerts to the slack channel", async () => {
            seedAlert(db, { contractId: "CA", channelType: "slack", channelTarget: "#oncall" });

            await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.slack.send).toHaveBeenCalledTimes(1);
            expect(channels.webhook.send).not.toHaveBeenCalled();
            expect(channels.pagerduty.send).not.toHaveBeenCalled();
        });

        it("routes pagerduty alerts to the pagerduty channel", async () => {
            seedAlert(db, { contractId: "CA", channelType: "pagerduty", channelTarget: "routing-key-123" });

            await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.pagerduty.send).toHaveBeenCalledTimes(1);
            expect(channels.webhook.send).not.toHaveBeenCalled();
            expect(channels.slack.send).not.toHaveBeenCalled();
        });

        it("passes correct target, event payload, and secret to webhook channel", async () => {
            seedAlert(db, {
                contractId: "CTEST1234",
                contractName: "test-contract",
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
                thresholdLedgers: 15_000,
                ttlAtFire: 7_000,
                webhookSecret: "test-secret-123",
            });

            await deliverPendingAlerts(db, "testnet", channels);

            const [url, event, secret] = channels.webhook.send.mock.calls[0]!;
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

        it("passes correct target and event to slack channel", async () => {
            seedAlert(db, { contractId: "CA", channelType: "slack", channelTarget: "#my-alerts" });

            await deliverPendingAlerts(db, "testnet", channels);

            const [channel, event] = channels.slack.send.mock.calls[0]!;
            expect(channel).toBe("#my-alerts");
            expect(event.type).toBe("threshold_crossed");
        });
    });

    describe("Delivered flag management", () => {
        it("marks the alert as delivered in the DB after successful send", async () => {
            const { alertFiredId } = seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);

            const row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(1);
        });

        it("does NOT mark as delivered when send fails", async () => {
            channels.webhook.send.mockRejectedValue(new Error("connection refused"));
            const { alertFiredId } = seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);

            const row = db
                .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number };
            expect(row.delivered).toBe(0);
        });

        it("does not re-deliver already-delivered alerts", async () => {
            seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);
            expect(channels.webhook.send).toHaveBeenCalledTimes(1);

            await deliverPendingAlerts(db, "testnet", channels);
            expect(channels.webhook.send).toHaveBeenCalledTimes(1);
        });

        it("retries a failed alert on the next cycle", async () => {
            channels.webhook.send
                .mockRejectedValueOnce(new Error("Slack down"))
                .mockResolvedValue(undefined);

            const { alertFiredId } = seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);
            expect(channels.webhook.send).toHaveBeenCalledTimes(1);

            let row = db
                .prepare("SELECT delivered, retry_count FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number; retry_count: number };
            expect(row.delivered).toBe(0);
            expect(row.retry_count).toBe(1);

            await deliverPendingAlerts(db, "testnet", channels);
            expect(channels.webhook.send).toHaveBeenCalledTimes(2);

            row = db
                .prepare("SELECT delivered, retry_count FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { delivered: number; retry_count: number };
            expect(row.delivered).toBe(1);
        });
    });

    describe("Retry limits", () => {
        it("stops retrying after MAX_RETRY_COUNT failures", async () => {
            channels.webhook.send.mockRejectedValue(new Error("permanent failure"));
            const { alertFiredId } = seedAlert(db, { contractId: "CA" });

            for (let i = 0; i < MAX_RETRY_COUNT; i++) {
                await deliverPendingAlerts(db, "testnet", channels);
            }

            expect(channels.webhook.send).toHaveBeenCalledTimes(MAX_RETRY_COUNT);

            await deliverPendingAlerts(db, "testnet", channels);
            expect(channels.webhook.send).toHaveBeenCalledTimes(MAX_RETRY_COUNT);

            const row = db
                .prepare("SELECT retry_count, delivered FROM alerts_fired WHERE id = ?")
                .get(alertFiredId) as { retry_count: number; delivered: number };
            expect(row.retry_count).toBe(MAX_RETRY_COUNT);
            expect(row.delivered).toBe(0);
        });

        it("reports abandoned count in result", async () => {
            channels.webhook.send.mockRejectedValue(new Error("fail"));
            const { alertFiredId } = seedAlert(db, { contractId: "CA" });

            db.prepare("UPDATE alerts_fired SET retry_count = ? WHERE id = ?")
                .run(MAX_RETRY_COUNT - 1, alertFiredId);

            const result = await deliverPendingAlerts(db, "testnet", channels);
            expect(result.abandoned).toBe(1);
        });
    });

    describe("Error resilience / channel isolation", () => {
        it("never throws even if all deliveries fail", async () => {
            channels.webhook.send.mockRejectedValue(new Error("all down"));
            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            await expect(deliverPendingAlerts(db, "testnet", channels)).resolves.not.toThrow();
        });

        it("continues delivering subsequent alerts even if one fails", async () => {
            channels.webhook.send
                .mockRejectedValueOnce(new Error("first failed"))
                .mockResolvedValue(undefined);

            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.webhook.send).toHaveBeenCalledTimes(2);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(1);
        });

        it("failing webhook does not block slack delivery", async () => {
            channels.webhook.send.mockRejectedValue(new Error("webhook down"));

            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a", channelType: "webhook" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b", channelType: "slack", channelTarget: "#alerts" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.webhook.send).toHaveBeenCalledTimes(1);
            expect(channels.slack.send).toHaveBeenCalledTimes(1);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(1);
        });

        it("collects error messages for all failed deliveries", async () => {
            channels.webhook.send.mockRejectedValue(new Error("connection timeout"));
            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.errors).toHaveLength(2);
            for (const err of result.errors) {
                expect(err).toContain("connection timeout");
            }
        });

        it("handles non-Error exceptions from delivery handlers", async () => {
            channels.webhook.send.mockRejectedValue("string error");
            seedAlert(db, { contractId: "CA" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.failed).toBe(1);
            expect(result.errors).toHaveLength(1);
        });

        it("reports unknown channel type as a failure without crashing", async () => {
            seedAlert(db, { contractId: "CA", channelType: "webhook" });
            const incompleteChannels = { slack: mockChannel() };

            const result = await deliverPendingAlerts(db, "testnet", incompleteChannels);

            expect(result.failed).toBe(1);
            expect(result.errors[0]).toContain("Unknown channel type: webhook");
        });
    });

    describe("Result counting", () => {
        it("counts attempted as total alerts processed regardless of outcome", async () => {
            channels.webhook.send
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error("fail"));

            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.attempted).toBe(2);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(1);
        });

        it("counts all successful deliveries across channels", async () => {
            seedAlert(db, { contractId: "CA", entryKeyXdr: "key-a", channelType: "webhook" });
            seedAlert(db, { contractId: "CB", entryKeyXdr: "key-b", channelType: "slack", channelTarget: "#alerts" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.attempted).toBe(2);
            expect(result.delivered).toBe(2);
            expect(result.failed).toBe(0);
        });
    });

    describe("Network isolation", () => {
        it("only delivers alerts for the specified network", async () => {
            seedAlert(db, { contractId: "TESTNET_C", network: "testnet" });
            seedAlert(db, { contractId: "MAINNET_C", network: "mainnet" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.webhook.send).toHaveBeenCalledTimes(1);
            expect(result.attempted).toBe(1);
        });

        it("delivers nothing when no alerts exist for the given network", async () => {
            seedAlert(db, { contractId: "MAINNET_C", network: "mainnet" });

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(channels.webhook.send).not.toHaveBeenCalled();
            expect(result.attempted).toBe(0);
        });
    });

    describe("Payload correctness", () => {
        it("event timestamp is a valid ISO 8601 string", async () => {
            seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);

            const [, event] = channels.webhook.send.mock.calls[0]!;
            expect(() => new Date(event.timestamp)).not.toThrow();
            expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
        });

        it("event entry.keyXdr matches the stored entry_key_xdr", async () => {
            seedAlert(db, { contractId: "CA", entryKeyXdr: "special-xdr-key" });

            await deliverPendingAlerts(db, "testnet", channels);

            const [, event] = channels.webhook.send.mock.calls[0]!;
            expect(event.entry.keyXdr).toBe("special-xdr-key");
        });

        it("event firedAtLedger matches the stored fired_at_ledger", async () => {
            seedAlert(db, { contractId: "CA" });

            await deliverPendingAlerts(db, "testnet", channels);

            const [, event] = channels.webhook.send.mock.calls[0]!;
            expect(event.firedAtLedger).toBe(2_500_000);
        });

        it("approximateTimeRemaining is a non-empty string", async () => {
            seedAlert(db, { contractId: "CA", ttlAtFire: 50_000 });

            await deliverPendingAlerts(db, "testnet", channels);

            const [, event] = channels.webhook.send.mock.calls[0]!;
            expect(typeof event.threshold.approximateTimeRemaining).toBe("string");
            expect(event.threshold.approximateTimeRemaining.length).toBeGreaterThan(0);
        });

        it("event includes severity field", async () => {
            seedAlert(db, { contractId: "CA", ttlAtFire: 1_000 });

            await deliverPendingAlerts(db, "testnet", channels);

            const [, event] = channels.webhook.send.mock.calls[0]!;
            expect(event.severity).toBe("critical");
        });
    });
});
