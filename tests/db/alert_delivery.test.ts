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