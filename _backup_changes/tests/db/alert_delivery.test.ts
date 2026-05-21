import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    upsertEntry,
    insertAlertConfig,
    recordAlertFired,
    resolveAlerts,
    getUndeliveredAlerts,
    markAlertDelivered,
} from "../../src/db/repositories";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedFull(
    db: Database.Database,
    opts: {
        contractId: string;
        contractName?: string;
        network?: string;
        entryKeyXdr?: string;
        entryType?: string;
        liveUntil?: number;
        channelType?: "webhook" | "slack" | "email";
        channelTarget?: string;
        thresholdLedgers?: number;
        ttlAtFire?: number;
        firedAtLedger?: number;
    }
): { entryId: number; alertConfigId: number; alertFiredId: number } {
    const network = opts.network ?? "testnet";
    const entryKeyXdr = opts.entryKeyXdr ?? "entry-key-xdr";
    const liveUntil = opts.liveUntil ?? 3_000_000;
    const thresholdLedgers = opts.thresholdLedgers ?? 20_000;
    const ttlAtFire = opts.ttlAtFire ?? 8_000;
    const firedAtLedger = opts.firedAtLedger ?? 2_500_000;

    insertContract(db, {
        id: opts.contractId,
        name: opts.contractName,
        network,
    });

    upsertEntry(db, {
        contract_id: opts.contractId,
        entry_key_xdr: entryKeyXdr,
        entry_type: opts.entryType ?? "instance",
        live_until_ledger: liveUntil,
        discovery_source: "deterministic",
    });

    const entry = db
        .prepare("SELECT id FROM contract_entries WHERE contract_id = ? AND entry_key_xdr = ?")
        .get(opts.contractId, entryKeyXdr) as { id: number };

    insertAlertConfig(db, {
        contract_id: opts.contractId,
        channel_type: opts.channelType ?? "webhook",
        channel_target: opts.channelTarget ?? "https://example.com/hook",
        threshold_ledgers: thresholdLedgers,
    });

    const config = db
        .prepare("SELECT id FROM alert_configs WHERE contract_id = ?")
        .get(opts.contractId) as { id: number };

    recordAlertFired(db, {
        alert_config_id: config.id,
        contract_entry_id: entry.id,
        fired_at_ledger: firedAtLedger,
        ttl_at_fire: ttlAtFire,
    });

    const fired = db
        .prepare("SELECT id FROM alerts_fired WHERE alert_config_id = ? AND contract_entry_id = ?")
        .get(config.id, entry.id) as { id: number };

    return { entryId: entry.id, alertConfigId: config.id, alertFiredId: fired.id };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getUndeliveredAlerts", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    // =========================================================================
    // 1. BASIC RETRIEVAL
    // =========================================================================
    describe("Basic retrieval", () => {
        it("returns an empty array when no alerts have been fired", () => {
            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toEqual([]);
        });

        it("returns one undelivered alert with correct shape", () => {
            seedFull(db, {
                contractId: "CONTRACT_A",
                contractName: "MyContract",
                network: "testnet",
                entryKeyXdr: "key-xdr-a",
                entryType: "instance",
                channelType: "webhook",
                channelTarget: "https://example.com/hook",
                thresholdLedgers: 20_000,
                ttlAtFire: 8_000,
                firedAtLedger: 2_500_000,
            });

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(1);

            const alert = result[0]!;
            expect(alert.contractId).toBe("CONTRACT_A");
            expect(alert.contractName).toBe("MyContract");
            expect(alert.network).toBe("testnet");
            expect(alert.entryKeyXdr).toBe("key-xdr-a");
            expect(alert.entryType).toBe("instance");
            expect(alert.channelType).toBe("webhook");
            expect(alert.channelTarget).toBe("https://example.com/hook");
            expect(alert.thresholdLedgers).toBe(20_000);
            expect(alert.remainingTTL).toBe(8_000);
            expect(alert.firedAtLedger).toBe(2_500_000);
            expect(typeof alert.alertFiredId).toBe("number");
            expect(typeof alert.entryId).toBe("number");
            expect(typeof alert.alertConfigId).toBe("number");
        });

        it("returns multiple undelivered alerts", () => {
            seedFull(db, { contractId: "CA", network: "testnet", entryKeyXdr: "key-a" });
            seedFull(db, { contractId: "CB", network: "testnet", entryKeyXdr: "key-b" });

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(2);
        });

        it("sets entryLabel to null when no label is stored", () => {
            seedFull(db, { contractId: "CA", network: "testnet" });
            const result = getUndeliveredAlerts(db, "testnet");
            expect(result[0]!.entryLabel).toBeNull();
        });

        it("returns the entryLabel when one is set", () => {
            insertContract(db, { id: "CA", network: "testnet" });
            upsertEntry(db, {
                contract_id: "CA",
                entry_key_xdr: "key-a",
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: 3_000_000,
                discovery_source: "deterministic",
            });
            const entry = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
                .get("CA") as { id: number };
            insertAlertConfig(db, {
                contract_id: "CA",
                channel_type: "webhook",
                channel_target: "https://example.com/hook",
                threshold_ledgers: 20_000,
            });
            const config = db
                .prepare("SELECT id FROM alert_configs WHERE contract_id = ?")
                .get("CA") as { id: number };
            recordAlertFired(db, {
                alert_config_id: config.id,
                contract_entry_id: entry.id,
                fired_at_ledger: 2_500_000,
                ttl_at_fire: 5_000,
            });

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result[0]!.entryLabel).toBe("Contract Instance");
        });
    });

    // =========================================================================
    // 2. NETWORK FILTERING
    // =========================================================================
    describe("Network filtering", () => {
        it("only returns alerts for the specified network", () => {
            seedFull(db, { contractId: "TESTNET_C", network: "testnet" });
            seedFull(db, { contractId: "MAINNET_C", network: "mainnet" });

            const testnetAlerts = getUndeliveredAlerts(db, "testnet");
            const mainnetAlerts = getUndeliveredAlerts(db, "mainnet");

            expect(testnetAlerts).toHaveLength(1);
            expect(testnetAlerts[0]!.network).toBe("testnet");

            expect(mainnetAlerts).toHaveLength(1);
            expect(mainnetAlerts[0]!.network).toBe("mainnet");
        });

        it("returns empty array for a network with no alerts", () => {
            seedFull(db, { contractId: "TESTNET_C", network: "testnet" });
            const result = getUndeliveredAlerts(db, "mainnet");
            expect(result).toHaveLength(0);
        });
    });

    // =========================================================================
    // 3. DELIVERED FILTERING
    // =========================================================================
    describe("Delivered filtering", () => {
        it("excludes alerts that have already been delivered", () => {
            const { alertFiredId } = seedFull(db, {
                contractId: "CA",
                network: "testnet",
            });
            markAlertDelivered(db, alertFiredId);

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(0);
        });

        it("returns only undelivered when some are delivered and some are not", () => {
            const { alertFiredId } = seedFull(db, {
                contractId: "CA",
                network: "testnet",
                entryKeyXdr: "key-a",
            });
            seedFull(db, {
                contractId: "CB",
                network: "testnet",
                entryKeyXdr: "key-b",
            });

            markAlertDelivered(db, alertFiredId);

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(1);
            expect(result[0]!.contractId).toBe("CB");
        });

        it("does not exclude resolved alerts — resolved != delivered", () => {
            const { entryId } = seedFull(db, { contractId: "CA", network: "testnet" });
            resolveAlerts(db, entryId);

            // resolved = 1, but delivered = 0 — still needs to be sent
            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(1);
        });
    });

    // =========================================================================
    // 4. MULTIPLE ALERTS PER CONTRACT
    // =========================================================================
    describe("Multiple alerts per contract/entry", () => {
        it("returns one row per alert_fired record, not per contract", () => {
            insertContract(db, { id: "CA", network: "testnet" });
            upsertEntry(db, {
                contract_id: "CA",
                entry_key_xdr: "key-a",
                entry_type: "instance",
                live_until_ledger: 3_000_000,
                discovery_source: "deterministic",
            });
            const entry = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
                .get("CA") as { id: number };

            // Two different alert configs (webhook + slack)
            insertAlertConfig(db, {
                contract_id: "CA",
                channel_type: "webhook",
                channel_target: "https://example.com/hook",
                threshold_ledgers: 20_000,
            });
            insertAlertConfig(db, {
                contract_id: "CA",
                channel_type: "slack",
                channel_target: "#oncall",
                threshold_ledgers: 5_000,
            });

            const configs = db
                .prepare("SELECT id FROM alert_configs WHERE contract_id = ?")
                .all("CA") as { id: number }[];

            for (const config of configs) {
                recordAlertFired(db, {
                    alert_config_id: config.id,
                    contract_entry_id: entry.id,
                    fired_at_ledger: 2_500_000,
                    ttl_at_fire: 3_000,
                });
            }

            const result = getUndeliveredAlerts(db, "testnet");
            expect(result).toHaveLength(2);
            const channelTypes = result.map((r) => r.channelType).sort();
            expect(channelTypes).toEqual(["slack", "webhook"]);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("markAlertDelivered", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("sets delivered = 1 on the target record", () => {
        const { alertFiredId } = seedFull(db, { contractId: "CA", network: "testnet" });

        markAlertDelivered(db, alertFiredId);

        const row = db
            .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
            .get(alertFiredId) as { delivered: number };
        expect(row.delivered).toBe(1);
    });

    it("sets delivered_at to a non-null timestamp", () => {
        const { alertFiredId } = seedFull(db, { contractId: "CA", network: "testnet" });

        markAlertDelivered(db, alertFiredId);

        const row = db
            .prepare("SELECT delivered_at FROM alerts_fired WHERE id = ?")
            .get(alertFiredId) as { delivered_at: string | null };
        expect(row.delivered_at).not.toBeNull();
    });

    it("does not affect other alert fired records", () => {
        const { alertFiredId: id1 } = seedFull(db, {
            contractId: "CA",
            network: "testnet",
            entryKeyXdr: "key-a",
        });
        const { alertFiredId: id2 } = seedFull(db, {
            contractId: "CB",
            network: "testnet",
            entryKeyXdr: "key-b",
        });

        markAlertDelivered(db, id1);

        const row = db
            .prepare("SELECT delivered FROM alerts_fired WHERE id = ?")
            .get(id2) as { delivered: number };
        expect(row.delivered).toBe(0);
    });

    it("is idempotent — calling it twice does not throw", () => {
        const { alertFiredId } = seedFull(db, { contractId: "CA", network: "testnet" });
        expect(() => {
            markAlertDelivered(db, alertFiredId);
            markAlertDelivered(db, alertFiredId);
        }).not.toThrow();
    });

    it("is a no-op for a non-existent id — does not throw", () => {
        expect(() => markAlertDelivered(db, 99999)).not.toThrow();
    });
});
