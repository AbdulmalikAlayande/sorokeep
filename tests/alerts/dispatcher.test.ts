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
});