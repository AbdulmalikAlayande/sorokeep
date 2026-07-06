import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    insertAlertConfig,
    getEntriesForContract,
    getAlertConfigsForContract,
    hasUnresolvedAlert,
    getUndeliveredAlerts,
    MAX_RETRY_COUNT,
} from "../../src/db/repositories";

const mockGetEntryTTLs = vi.fn();

vi.mock("../../src/rpc/client.js", () => ({
    StellarRpcClient: class {
        getEntryTTLs = mockGetEntryTTLs;
        getCurrentLedger = vi.fn().mockResolvedValue(2_500_000);
        getNetwork = vi.fn().mockReturnValue("testnet");
    },
}));

const mockSendWebhookAlert = vi.fn();
const mockSendSlackAlert = vi.fn();
const mockSendPagerDutyAlert = vi.fn();
const mockSendDiscordAlert = vi.fn();
const mockSendTelegramAlert = vi.fn();

vi.mock("../../src/alerts/webhook.js", () => ({
    sendWebhookAlert: (...args: unknown[]) => mockSendWebhookAlert(...args),
}));
vi.mock("../../src/alerts/slack.js", () => ({
    sendSlackAlert: (...args: unknown[]) => mockSendSlackAlert(...args),
}));
vi.mock("../../src/alerts/pagerduty.js", () => ({
    sendPagerDutyAlert: (...args: unknown[]) => mockSendPagerDutyAlert(...args),
}));
vi.mock("../../src/alerts/discord.js", () => ({
    sendDiscordAlert: (...args: unknown[]) => mockSendDiscordAlert(...args),
}));
vi.mock("../../src/alerts/telegram.js", () => ({
    sendTelegramAlert: (...args: unknown[]) => mockSendTelegramAlert(...args),
}));

import { runMonitorCycle } from "../../src/core/monitor";
import { deliverPendingAlerts } from "../../src/alerts/dispatcher";

const LEDGER = 2_500_000;
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ENTRY_KEY = "instance-key-xdr";
const THRESHOLD = 15_000;

function seedContractWithSlackAlert(db: Database.Database) {
    insertContract(db, { id: CONTRACT_ID, name: "test-contract", network: "testnet" });
    upsertEntry(db, {
        contract_id: CONTRACT_ID,
        entry_key_xdr: ENTRY_KEY,
        entry_type: "instance",
        live_until_ledger: LEDGER + 50_000,
        discovery_source: "deterministic",
    });
    insertAlertConfig(db, {
        contract_id: CONTRACT_ID,
        channel_type: "slack",
        channel_target: "#ops-alerts",
        threshold_ledgers: THRESHOLD,
    });
}

function mockCriticalTTL(remainingTTL: number) {
    mockGetEntryTTLs.mockResolvedValue({
        latestLedger: LEDGER,
        entries: [{
            entryKeyXdr: ENTRY_KEY,
            liveUntilLedgerSeq: LEDGER + remainingTTL,
            lastModifiedLedgerSeq: LEDGER - 10,
            remainingTTL,
        }],
    });
}

function getAlertFiredRows(db: Database.Database) {
    return db.prepare("SELECT * FROM alerts_fired ORDER BY id ASC").all() as Array<{
        id: number;
        alert_config_id: number;
        contract_entry_id: number;
        fired_at_ledger: number;
        ttl_at_fire: number;
        resolved: number;
        resolved_at: string | null;
        delivered: number;
        delivered_at: string | null;
        retry_count: number;
    }>;
}

describe("Alert lifecycle E2E", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    describe("Full pipeline: TTL discovery → alert fire → delivery", () => {
        it("fires an alert when monitor detects critical TTL, then delivers it", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(3_000);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.thresholdsCrossed).toBe(1);
            expect(monitorResult.errors).toHaveLength(0);

            const firedRows = getAlertFiredRows(db);
            expect(firedRows).toHaveLength(1);
            expect(firedRows[0]!.ttl_at_fire).toBe(3_000);
            expect(firedRows[0]!.delivered).toBe(0);
            expect(firedRows[0]!.resolved).toBe(0);

            mockSendSlackAlert.mockResolvedValue(undefined);
            const deliveryResult = await deliverPendingAlerts(db, "testnet");
            expect(deliveryResult.attempted).toBe(1);
            expect(deliveryResult.delivered).toBe(1);
            expect(deliveryResult.failed).toBe(0);

            expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
            const [channel, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(channel).toBe("#ops-alerts");
            expect(event.type).toBe("threshold_crossed");
            expect(event.contractId).toBe(CONTRACT_ID);
            expect(event.severity).toBe("critical");

            const updatedRows = getAlertFiredRows(db);
            expect(updatedRows[0]!.delivered).toBe(1);
            expect(updatedRows[0]!.delivered_at).not.toBeNull();
        });

        it("completes fire → deliver → resolve → re-fire cycle", async () => {
            seedContractWithSlackAlert(db);
            mockSendSlackAlert.mockResolvedValue(undefined);

            mockCriticalTTL(2_000);
            await runMonitorCycle(db, "testnet");
            await deliverPendingAlerts(db, "testnet");

            let rows = getAlertFiredRows(db);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.delivered).toBe(1);

            mockCriticalTTL(100_000);
            const resolveResult = await runMonitorCycle(db, "testnet");
            expect(resolveResult.alertsResolved).toBeGreaterThan(0);

            rows = getAlertFiredRows(db);
            expect(rows[0]!.resolved).toBe(1);
            expect(rows[0]!.resolved_at).not.toBeNull();

            mockCriticalTTL(1_000);
            const reFireResult = await runMonitorCycle(db, "testnet");
            expect(reFireResult.thresholdsCrossed).toBe(1);

            rows = getAlertFiredRows(db);
            expect(rows).toHaveLength(2);
            expect(rows[1]!.delivered).toBe(0);
            expect(rows[1]!.ttl_at_fire).toBe(1_000);
        });
    });

    describe("DB state transitions", () => {
        it("transitions: undelivered → delivered after successful send", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(5_000);
            mockSendSlackAlert.mockResolvedValue(undefined);

            await runMonitorCycle(db, "testnet");

            const before = getAlertFiredRows(db);
            expect(before[0]!.delivered).toBe(0);
            expect(before[0]!.delivered_at).toBeNull();
            expect(before[0]!.retry_count).toBe(0);

            await deliverPendingAlerts(db, "testnet");

            const after = getAlertFiredRows(db);
            expect(after[0]!.delivered).toBe(1);
            expect(after[0]!.delivered_at).not.toBeNull();
        });

        it("transitions: undelivered → retry_count incremented on failure", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(5_000);
            mockSendSlackAlert.mockRejectedValue(new Error("Slack API down"));

            await runMonitorCycle(db, "testnet");
            await deliverPendingAlerts(db, "testnet");

            const row = getAlertFiredRows(db)[0]!;
            expect(row.delivered).toBe(0);
            expect(row.retry_count).toBe(1);
        });

        it("transitions: unresolved → resolved when TTL recovers above threshold", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(5_000);

            await runMonitorCycle(db, "testnet");

            const configs = getAlertConfigsForContract(db, CONTRACT_ID);
            const entries = getEntriesForContract(db, CONTRACT_ID);
            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(true);

            mockCriticalTTL(100_000);
            await runMonitorCycle(db, "testnet");

            expect(hasUnresolvedAlert(db, configs[0]!.id, entries[0]!.id)).toBe(false);
            const row = getAlertFiredRows(db)[0]!;
            expect(row.resolved).toBe(1);
        });

        it("alert stays unresolved when TTL improves but remains below threshold", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(2_000);
            await runMonitorCycle(db, "testnet");

            mockCriticalTTL(10_000);
            await runMonitorCycle(db, "testnet");

            const row = getAlertFiredRows(db)[0]!;
            expect(row.resolved).toBe(0);
        });

        it("exhausts retries and abandons after MAX_RETRY_COUNT failures", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(3_000);
            mockSendSlackAlert.mockRejectedValue(new Error("permanent failure"));

            await runMonitorCycle(db, "testnet");

            for (let i = 0; i < MAX_RETRY_COUNT; i++) {
                await deliverPendingAlerts(db, "testnet");
            }

            const row = getAlertFiredRows(db)[0]!;
            expect(row.retry_count).toBe(MAX_RETRY_COUNT);
            expect(row.delivered).toBe(0);

            const finalResult = await deliverPendingAlerts(db, "testnet");
            expect(finalResult.attempted).toBe(0);
            expect(mockSendSlackAlert).toHaveBeenCalledTimes(MAX_RETRY_COUNT);
        });
    });

    describe("Deduplication across cycles", () => {
        it("does not re-fire an already unresolved alert on subsequent monitor cycles", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(5_000);

            const r1 = await runMonitorCycle(db, "testnet");
            const r2 = await runMonitorCycle(db, "testnet");
            const r3 = await runMonitorCycle(db, "testnet");

            expect(r1.thresholdsCrossed).toBe(1);
            expect(r2.thresholdsCrossed).toBe(0);
            expect(r3.thresholdsCrossed).toBe(0);
            expect(getAlertFiredRows(db)).toHaveLength(1);
        });

        it("does not re-deliver an already delivered alert", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(5_000);
            mockSendSlackAlert.mockResolvedValue(undefined);

            await runMonitorCycle(db, "testnet");
            await deliverPendingAlerts(db, "testnet");
            await deliverPendingAlerts(db, "testnet");

            expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
        });
    });

    describe("Multi-channel delivery", () => {
        it("delivers via webhook when configured with webhook channel", async () => {
            insertContract(db, { id: CONTRACT_ID, name: "test-contract", network: "testnet" });
            upsertEntry(db, {
                contract_id: CONTRACT_ID,
                entry_key_xdr: ENTRY_KEY,
                entry_type: "instance",
                live_until_ledger: LEDGER + 50_000,
                discovery_source: "deterministic",
            });
            insertAlertConfig(db, {
                contract_id: CONTRACT_ID,
                channel_type: "webhook",
                channel_target: "https://ops.example.com/hook",
                threshold_ledgers: THRESHOLD,
                webhook_secret: "s3cret",
            });

            mockCriticalTTL(3_000);
            mockSendWebhookAlert.mockResolvedValue(undefined);

            await runMonitorCycle(db, "testnet");
            const deliveryResult = await deliverPendingAlerts(db, "testnet");

            expect(deliveryResult.delivered).toBe(1);
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            expect(mockSendSlackAlert).not.toHaveBeenCalled();

            const [url, event, secret] = mockSendWebhookAlert.mock.calls[0]!;
            expect(url).toBe("https://ops.example.com/hook");
            expect(secret).toBe("s3cret");
            expect(event.contractId).toBe(CONTRACT_ID);
        });

        it("fires separate alerts for multiple configs on same contract", async () => {
            insertContract(db, { id: CONTRACT_ID, name: "multi-alert", network: "testnet" });
            upsertEntry(db, {
                contract_id: CONTRACT_ID,
                entry_key_xdr: ENTRY_KEY,
                entry_type: "instance",
                live_until_ledger: LEDGER + 50_000,
                discovery_source: "deterministic",
            });
            insertAlertConfig(db, {
                contract_id: CONTRACT_ID,
                channel_type: "slack",
                channel_target: "#ops",
                threshold_ledgers: THRESHOLD,
            });
            insertAlertConfig(db, {
                contract_id: CONTRACT_ID,
                channel_type: "webhook",
                channel_target: "https://hook.example.com",
                threshold_ledgers: THRESHOLD,
            });

            mockCriticalTTL(3_000);
            mockSendSlackAlert.mockResolvedValue(undefined);
            mockSendWebhookAlert.mockResolvedValue(undefined);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.thresholdsCrossed).toBe(2);

            const deliveryResult = await deliverPendingAlerts(db, "testnet");
            expect(deliveryResult.delivered).toBe(2);
            expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
        });
    });

    describe("Network isolation", () => {
        it("monitor and delivery only process alerts for the target network", async () => {
            insertContract(db, { id: "MAINNET_CONTRACT", network: "mainnet" });
            upsertEntry(db, {
                contract_id: "MAINNET_CONTRACT",
                entry_key_xdr: "mainnet-key",
                entry_type: "instance",
                live_until_ledger: LEDGER + 50_000,
                discovery_source: "deterministic",
            });
            insertAlertConfig(db, {
                contract_id: "MAINNET_CONTRACT",
                channel_type: "slack",
                channel_target: "#mainnet-alerts",
                threshold_ledgers: THRESHOLD,
            });

            seedContractWithSlackAlert(db);
            mockCriticalTTL(3_000);
            mockSendSlackAlert.mockResolvedValue(undefined);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.contractsChecked).toBe(1);
            expect(monitorResult.thresholdsCrossed).toBe(1);

            const deliveryResult = await deliverPendingAlerts(db, "testnet");
            expect(deliveryResult.delivered).toBe(1);

            const mainnetDelivery = await deliverPendingAlerts(db, "mainnet");
            expect(mainnetDelivery.attempted).toBe(0);
        });
    });

    describe("Payload correctness through the pipeline", () => {
        it("slack event payload contains correct contract, severity, and threshold data", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(2_000);
            mockSendSlackAlert.mockResolvedValue(undefined);

            await runMonitorCycle(db, "testnet");
            await deliverPendingAlerts(db, "testnet");

            const [channel, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(channel).toBe("#ops-alerts");
            expect(event.type).toBe("threshold_crossed");
            expect(event.contractId).toBe(CONTRACT_ID);
            expect(event.contractName).toBe("test-contract");
            expect(event.network).toBe("testnet");
            expect(event.severity).toBe("critical");
            expect(event.entry.keyXdr).toBe(ENTRY_KEY);
            expect(event.entry.type).toBe("instance");
            expect(event.threshold.configuredLedgers).toBe(THRESHOLD);
            expect(event.threshold.currentRemainingLedgers).toBe(2_000);
            expect(event.threshold.approximateTimeRemaining).toBeTruthy();
            expect(event.firedAtLedger).toBe(LEDGER);
            expect(() => new Date(event.timestamp)).not.toThrow();
        });

        it("warning severity for TTL below threshold but above 25%", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(10_000);
            mockSendSlackAlert.mockResolvedValue(undefined);

            await runMonitorCycle(db, "testnet");
            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(event.severity).toBe("warning");
        });
    });

    describe("Retry then succeed", () => {
        it("fails delivery, then succeeds on next cycle", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(3_000);

            await runMonitorCycle(db, "testnet");

            mockSendSlackAlert.mockRejectedValueOnce(new Error("transient failure"));
            const r1 = await deliverPendingAlerts(db, "testnet");
            expect(r1.failed).toBe(1);
            expect(r1.delivered).toBe(0);

            let row = getAlertFiredRows(db)[0]!;
            expect(row.retry_count).toBe(1);
            expect(row.delivered).toBe(0);

            mockSendSlackAlert.mockResolvedValue(undefined);
            const r2 = await deliverPendingAlerts(db, "testnet");
            expect(r2.delivered).toBe(1);

            row = getAlertFiredRows(db)[0]!;
            expect(row.delivered).toBe(1);
            expect(row.retry_count).toBe(1);
        });
    });

    describe("Edge cases", () => {
        it("no alerts fire when no contracts are registered", async () => {
            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.contractsChecked).toBe(0);
            expect(monitorResult.thresholdsCrossed).toBe(0);

            const deliveryResult = await deliverPendingAlerts(db, "testnet");
            expect(deliveryResult.attempted).toBe(0);
        });

        it("monitor runs but no alerts fire when TTL is above threshold", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(50_000);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.contractsChecked).toBe(1);
            expect(monitorResult.entriesUpdated).toBe(1);
            expect(monitorResult.thresholdsCrossed).toBe(0);

            expect(getUndeliveredAlerts(db, "testnet")).toHaveLength(0);
        });

        it("TTL at exactly threshold does not fire (strictly less than)", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(THRESHOLD);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.thresholdsCrossed).toBe(0);
        });

        it("TTL one ledger below threshold fires", async () => {
            seedContractWithSlackAlert(db);
            mockCriticalTTL(THRESHOLD - 1);

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.thresholdsCrossed).toBe(1);
        });

        it("handles expired TTL (negative remaining)", async () => {
            seedContractWithSlackAlert(db);
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: LEDGER,
                entries: [{
                    entryKeyXdr: ENTRY_KEY,
                    liveUntilLedgerSeq: LEDGER - 500,
                    lastModifiedLedgerSeq: LEDGER - 1000,
                    remainingTTL: -500,
                }],
            });

            const monitorResult = await runMonitorCycle(db, "testnet");
            expect(monitorResult.thresholdsCrossed).toBe(1);

            mockSendSlackAlert.mockResolvedValue(undefined);
            await deliverPendingAlerts(db, "testnet");

            const [, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
        });
    });
});
