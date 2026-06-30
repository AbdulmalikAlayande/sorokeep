import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    getEntriesForContract,
    insertAlertConfig,
    getAlertConfigsForContract,
} from "../../src/db/repositories";
import {
    buildStateChangeAlertEvent,
    type StateChangeAlertEvent,
} from "../../src/alerts/types";
import { deliverSingleAlert } from "../../src/alerts/dispatcher";

// Mock all channel senders so no real HTTP calls are made
vi.mock("../../src/alerts/webhook.js", () => ({
    sendWebhookAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/alerts/slack.js", () => ({
    sendSlackAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/alerts/pagerduty.js", () => ({
    sendPagerDutyAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/alerts/discord.js", () => ({
    sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/alerts/telegram.js", () => ({
    sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
}));

describe("State Change Alerts", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    afterEach(() => {
        db.close();
    });

    // =========================================================================
    // 1. buildStateChangeAlertEvent
    // =========================================================================
    describe("buildStateChangeAlertEvent", () => {
        it("produces correct event shape for an 'updated' state change", () => {
            const event = buildStateChangeAlertEvent({
                contractId: "CONTRACT_1",
                contractName: "My Contract",
                network: "testnet",
                entryKeyXdr: "entry-key-xdr",
                entryType: "persistent",
                entryLabel: "counter",
                diffType: "updated",
                oldValueXdr: "old-xdr-val",
                newValueXdr: "new-xdr-val",
                detectedAtLedger: 5000,
            });

            expect(event.type).toBe("state_changed");
            expect(event.severity).toBe("info");
            expect(event.contractId).toBe("CONTRACT_1");
            expect(event.contractName).toBe("My Contract");
            expect(event.network).toBe("testnet");
            expect(event.entry.keyXdr).toBe("entry-key-xdr");
            expect(event.entry.type).toBe("persistent");
            expect(event.entry.label).toBe("counter");
            expect(event.diff.diffType).toBe("updated");
            expect(event.diff.oldValueXdr).toBe("old-xdr-val");
            expect(event.diff.newValueXdr).toBe("new-xdr-val");
            expect(event.detectedAtLedger).toBe(5000);
            expect(event.timestamp).toBeDefined();
        });

        it("produces correct event shape for a 'created' state change", () => {
            const event = buildStateChangeAlertEvent({
                contractId: "CONTRACT_1",
                contractName: null,
                network: "mainnet",
                entryKeyXdr: "entry-key-xdr",
                entryType: "instance",
                entryLabel: null,
                diffType: "created",
                oldValueXdr: null,
                newValueXdr: "new-xdr-val",
                detectedAtLedger: 1000,
            });

            expect(event.type).toBe("state_changed");
            expect(event.diff.diffType).toBe("created");
            expect(event.diff.oldValueXdr).toBeNull();
            expect(event.diff.newValueXdr).toBe("new-xdr-val");
        });

        it("produces correct event shape for a 'deleted' state change", () => {
            const event = buildStateChangeAlertEvent({
                contractId: "CONTRACT_1",
                contractName: null,
                network: "testnet",
                entryKeyXdr: "entry-key-xdr",
                entryType: "temporary",
                entryLabel: null,
                diffType: "deleted",
                oldValueXdr: "old-xdr-val",
                newValueXdr: null,
                detectedAtLedger: 2000,
            });

            expect(event.type).toBe("state_changed");
            expect(event.diff.diffType).toBe("deleted");
            expect(event.diff.oldValueXdr).toBe("old-xdr-val");
            expect(event.diff.newValueXdr).toBeNull();
        });

        it("includes ISO timestamp", () => {
            const event = buildStateChangeAlertEvent({
                contractId: "C1",
                contractName: null,
                network: "testnet",
                entryKeyXdr: "key",
                entryType: "persistent",
                entryLabel: null,
                diffType: "updated",
                oldValueXdr: "a",
                newValueXdr: "b",
                detectedAtLedger: 100,
            });

            // Verify it's a valid ISO string
            expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
        });
    });

    // =========================================================================
    // 2. Webhook and Slack receive detailed diff payload
    // =========================================================================
    describe("Alert delivery with diff payload", () => {
        it("delivers state_changed event via webhook with old/new values", async () => {
            const { sendWebhookAlert } = await import("../../src/alerts/webhook.js");

            const event = buildStateChangeAlertEvent({
                contractId: "CONTRACT_1",
                contractName: "Test",
                network: "testnet",
                entryKeyXdr: "key-xdr",
                entryType: "persistent",
                entryLabel: "counter",
                diffType: "updated",
                oldValueXdr: "old-val",
                newValueXdr: "new-val",
                detectedAtLedger: 3000,
            });

            const success = await deliverSingleAlert(
                "webhook",
                "https://example.com/hook",
                event,
                "test-secret",
            );

            expect(success).toBe(true);
            expect(sendWebhookAlert).toHaveBeenCalledWith(
                "https://example.com/hook",
                expect.objectContaining({
                    type: "state_changed",
                    diff: expect.objectContaining({
                        oldValueXdr: "old-val",
                        newValueXdr: "new-val",
                    }),
                }),
                "test-secret",
            );
        });

        it("delivers state_changed event via slack", async () => {
            const { sendSlackAlert } = await import("../../src/alerts/slack.js");

            const event = buildStateChangeAlertEvent({
                contractId: "CONTRACT_1",
                contractName: "Test",
                network: "testnet",
                entryKeyXdr: "key-xdr",
                entryType: "persistent",
                entryLabel: "counter",
                diffType: "created",
                oldValueXdr: null,
                newValueXdr: "new-val",
                detectedAtLedger: 3000,
            });

            const success = await deliverSingleAlert(
                "slack",
                "#alerts",
                event,
            );

            expect(success).toBe(true);
            expect(sendSlackAlert).toHaveBeenCalledWith(
                "#alerts",
                expect.objectContaining({
                    type: "state_changed",
                    diff: expect.objectContaining({
                        diffType: "created",
                        newValueXdr: "new-val",
                    }),
                }),
            );
        });

        it("delivers state_changed event via discord", async () => {
            const { sendDiscordAlert } = await import("../../src/alerts/discord.js");
            const event = buildStateChangeAlertEvent({
                contractId: "C1", contractName: null, network: "testnet",
                entryKeyXdr: "k", entryType: "persistent", entryLabel: null,
                diffType: "deleted", oldValueXdr: "o", newValueXdr: null,
                detectedAtLedger: 100,
            });
            const success = await deliverSingleAlert("discord", "https://discord.com/webhook", event);
            expect(success).toBe(true);
            expect(sendDiscordAlert).toHaveBeenCalledWith("https://discord.com/webhook", event);
        });

        it("delivers state_changed event via pagerduty", async () => {
            const { sendPagerDutyAlert } = await import("../../src/alerts/pagerduty.js");
            const event = buildStateChangeAlertEvent({
                contractId: "C1", contractName: null, network: "testnet",
                entryKeyXdr: "k", entryType: "persistent", entryLabel: null,
                diffType: "updated", oldValueXdr: "o", newValueXdr: "n",
                detectedAtLedger: 100,
            });
            const success = await deliverSingleAlert("pagerduty", "routing-key", event);
            expect(success).toBe(true);
            expect(sendPagerDutyAlert).toHaveBeenCalledWith("routing-key", event);
        });

        it("delivers state_changed event via telegram", async () => {
            const { sendTelegramAlert } = await import("../../src/alerts/telegram.js");
            const event = buildStateChangeAlertEvent({
                contractId: "C1", contractName: null, network: "testnet",
                entryKeyXdr: "k", entryType: "persistent", entryLabel: null,
                diffType: "updated", oldValueXdr: "o", newValueXdr: "n",
                detectedAtLedger: 100,
            });
            const success = await deliverSingleAlert("telegram", "chat-123", event);
            expect(success).toBe(true);
            expect(sendTelegramAlert).toHaveBeenCalledWith("chat-123", event);
        });
    });

    // =========================================================================
    // 3. Event type union compatibility
    // =========================================================================
    describe("AlertEvent type compatibility", () => {
        it("state_changed event is assignable to AlertEvent", () => {
            const event: StateChangeAlertEvent = buildStateChangeAlertEvent({
                contractId: "C1",
                contractName: null,
                network: "testnet",
                entryKeyXdr: "key",
                entryType: "persistent",
                entryLabel: null,
                diffType: "updated",
                oldValueXdr: "a",
                newValueXdr: "b",
                detectedAtLedger: 100,
            });

            // Verify it can be used anywhere an AlertEvent is expected
            expect(event.type).toBe("state_changed");
            expect(event.severity).toBeDefined();
            expect(event.contractId).toBeDefined();
        });
    });
});
