import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    alertsDeliveredTotal,
    alertsFailedTotal,
    alertsAbandonedTotal,
    alertDeliveryDurationSeconds,
} from "../../../src/observability/metrics/alerts.js";
import { deliverSingleAlert, deliverPendingAlerts } from "../../../src/alerts/dispatcher.js";
import { getDatabaseForTesting } from "../../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    insertAlertConfig,
    recordAlertFired,
} from "../../../src/db/repositories.js";
import type { AlertEvent, AlertChannel } from "../../../src/alerts/types.js";

async function counterValue(counter: typeof alertsDeliveredTotal, channelType: string): Promise<number> {
    const { values } = await counter.get();
    return values.find((v) => v.labels.channel_type === channelType)?.value ?? 0;
}

async function histogramCount(channelType: string): Promise<number> {
    const { values } = await alertDeliveryDurationSeconds.get();
    return values.find((v) => v.labels.channel_type === channelType && v.metricName?.endsWith("_count"))?.value ?? 0;
}

const dummyEvent: AlertEvent = {
    type: "threshold_crossed",
    severity: "warning",
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    contractName: null,
    network: "testnet",
    entry: {
        keyXdr: "key",
        type: "instance",
        label: null,
    },
    threshold: {
        configuredLedgers: 1000,
        currentRemainingLedgers: 500,
        approximateTimeRemaining: "~1h",
    },
    firedAtLedger: 100,
    timestamp: new Date().toISOString(),
};

describe("alert delivery metrics", () => {
    beforeEach(() => {
        alertsDeliveredTotal.reset();
        alertsFailedTotal.reset();
        alertsAbandonedTotal.reset();
        alertDeliveryDurationSeconds.reset();
    });

    describe("deliverSingleAlert", () => {
        it("increments alertsDeliveredTotal and observes duration on success", async () => {
            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockResolvedValue(undefined) },
            };

            const ok = await deliverSingleAlert("webhook", "https://example.com", dummyEvent, null, channels);

            expect(ok).toBe(true);
            expect(await counterValue(alertsDeliveredTotal, "webhook")).toBe(1);
            expect(await counterValue(alertsFailedTotal, "webhook")).toBe(0);
            expect(await histogramCount("webhook")).toBe(1);
        });

        it("increments alertsFailedTotal on failure", async () => {
            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockRejectedValue(new Error("boom")) },
            };

            const ok = await deliverSingleAlert("webhook", "https://example.com", dummyEvent, null, channels);

            expect(ok).toBe(false);
            expect(await counterValue(alertsFailedTotal, "webhook")).toBe(1);
            expect(await counterValue(alertsDeliveredTotal, "webhook")).toBe(0);
            expect(await histogramCount("webhook")).toBe(1);
        });

        it("labels counters independently per channel type", async () => {
            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockResolvedValue(undefined) },
                slack: { send: vi.fn().mockResolvedValue(undefined) },
            };

            await deliverSingleAlert("webhook", "target", dummyEvent, null, channels);
            await deliverSingleAlert("slack", "target", dummyEvent, null, channels);
            await deliverSingleAlert("slack", "target", dummyEvent, null, channels);

            expect(await counterValue(alertsDeliveredTotal, "webhook")).toBe(1);
            expect(await counterValue(alertsDeliveredTotal, "slack")).toBe(2);
        });
    });

    describe("deliverPendingAlerts", () => {
        function seedPendingAlert(db: ReturnType<typeof getDatabaseForTesting>): number {
            const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
            insertContract(db, { id: contractId, name: "Test", network: "testnet" });
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "key1",
                entry_type: "instance",
                label: undefined,
                live_until_ledger: 1000,
                last_modified_ledger: 900,
                discovery_source: "deterministic",
            });
            const entry = getEntriesForContract(db, contractId)[0]!;
            const configId = insertAlertConfig(db, {
                contract_id: contractId,
                channel_type: "webhook",
                channel_target: "https://example.com",
                threshold_ledgers: 500,
            });
            recordAlertFired(db, {
                alert_config_id: configId,
                contract_entry_id: entry.id,
                fired_at_ledger: 100,
                ttl_at_fire: 400,
            });
            return entry.id;
        }

        it("increments alertsDeliveredTotal for each successfully delivered queued alert", async () => {
            const db = getDatabaseForTesting();
            seedPendingAlert(db);

            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockResolvedValue(undefined) },
            };

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.delivered).toBe(1);
            expect(await counterValue(alertsDeliveredTotal, "webhook")).toBe(1);
        });

        it("increments alertsFailedTotal on a failed delivery attempt", async () => {
            const db = getDatabaseForTesting();
            seedPendingAlert(db);

            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockRejectedValue(new Error("unreachable")) },
            };

            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.failed).toBe(1);
            expect(await counterValue(alertsFailedTotal, "webhook")).toBe(1);
        });

        it("increments alertsAbandonedTotal once retries are exhausted", async () => {
            const db = getDatabaseForTesting();
            seedPendingAlert(db);

            const channels: Record<string, AlertChannel> = {
                webhook: { send: vi.fn().mockRejectedValue(new Error("unreachable")) },
            };

            // MAX_RETRY_COUNT is 5 — drive retry_count up to 4, then one more
            // failure crosses the threshold and the alert is abandoned.
            for (let i = 0; i < 4; i++) {
                await deliverPendingAlerts(db, "testnet", channels);
            }
            const result = await deliverPendingAlerts(db, "testnet", channels);

            expect(result.abandoned).toBe(1);
            expect(await counterValue(alertsAbandonedTotal, "webhook")).toBe(1);
        });
    });
});
