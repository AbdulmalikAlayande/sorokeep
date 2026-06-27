import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import * as repo from "../../src/db/repositories.js";

describe("Database Repositories", () => {
    let db: any;

    beforeEach(() => {
        db = getDatabaseForTesting();
        // Since getDatabaseForTesting might miss live migrations that getDatabase does, let's run them just in case.
        const migrations = [
            `ALTER TABLE alerts_fired ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0`,
            `ALTER TABLE alerts_fired ADD COLUMN delivered_at TEXT`,
            `ALTER TABLE alerts_fired ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
            `ALTER TABLE alert_configs ADD COLUMN webhook_secret TEXT`,
            `CREATE TABLE IF NOT EXISTS channel_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_key TEXT NOT NULL UNIQUE,
                keypair_source TEXT,
                label TEXT,
                network TEXT NOT NULL DEFAULT 'testnet',
                funded BOOLEAN NOT NULL DEFAULT 0,
                balance_xlm REAL,
                balance_checked_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `ALTER TABLE contracts ADD COLUMN last_introspected_at DATETIME`,
        ];
        for (const sql of migrations) {
            try { db.exec(sql); } catch { /* ignore */ }
        }
        
        try {
            db.exec("PRAGMA foreign_keys = OFF;");
            db.exec("BEGIN TRANSACTION;");
            db.exec(`
                CREATE TABLE IF NOT EXISTS alert_configs_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
                    channel_type TEXT NOT NULL CHECK(channel_type IN ('slack', 'webhook', 'pagerduty')),
                    channel_target TEXT NOT NULL,
                    threshold_ledgers INTEGER NOT NULL,
                    webhook_secret TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            `);
            db.exec(`
                INSERT OR IGNORE INTO alert_configs_new (id, contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret, created_at)
                SELECT id, contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret, created_at
                FROM alert_configs
            `);
            db.exec(`DROP TABLE alert_configs;`);
            db.exec(`ALTER TABLE alert_configs_new RENAME TO alert_configs;`);
            db.exec("COMMIT;");
            db.exec("PRAGMA foreign_keys = ON;");
        } catch {
            // ignore failure if tables already altered
        }
    });

    afterEach(() => {
        db.close();
    });

    describe("Contract CRUD", () => {
        it("inserts, gets, and deletes a contract", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", name: "Contract 1" });
            
            const c1 = repo.getContract(db, "C1");
            expect(c1).toBeDefined();
            expect(c1?.name).toBe("Contract 1");
            
            repo.insertContract(db, { id: "C1", network: "public", name: "Contract 1 Updated", wasm_hash: "abcd", tags: "defi" });
            const c1Updated = repo.getContract(db, "C1");
            expect(c1Updated?.name).toBe("Contract 1 Updated");
            expect(c1Updated?.network).toBe("public");
            expect(c1Updated?.wasm_hash).toBe("abcd");
            expect(c1Updated?.tags).toBe("defi");

            const all = repo.getAllContracts(db);
            expect(all.length).toBe(1);

            repo.updateLastCheckedLedger(db, "C1", 12345);
            const c1Checked = repo.getContract(db, "C1");
            expect(c1Checked?.last_checked_ledger).toBe(12345);

            repo.deleteContract(db, "C1");
            expect(repo.getContract(db, "C1")).toBeUndefined();
        });

        it("handles introspection cache", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            expect(repo.isIntrospectionCacheValid(db, "C1")).toBe(false);

            repo.updateLastIntrospectedAt(db, "C1", new Date().toISOString());
            expect(repo.isIntrospectionCacheValid(db, "C1")).toBe(true);

            repo.updateLastIntrospectedAt(db, "C1", new Date(Date.now() - 25 * 3600 * 1000).toISOString());
            expect(repo.isIntrospectionCacheValid(db, "C1")).toBe(false);
        });
    });

    describe("ContractEntry CRUD", () => {
        it("upserts and gets entries", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            
            repo.upsertEntry(db, {
                contract_id: "C1",
                entry_key_xdr: "xdr1",
                entry_type: "instance",
                label: "lbl",
                live_until_ledger: 1000,
                last_modified_ledger: 900
            });
            let entries = repo.getEntriesForContract(db, "C1");
            expect(entries.length).toBe(1);
            expect(entries[0].entry_type).toBe("instance");

            repo.upsertEntry(db, {
                contract_id: "C1",
                entry_key_xdr: "xdr1",
                entry_type: "instance",
                live_until_ledger: 2000,
                last_modified_ledger: 1900
            });
            entries = repo.getEntriesForContract(db, "C1");
            expect(entries.length).toBe(1);
            expect(entries[0].live_until_ledger).toBe(2000);
        });
    });

    describe("ExtensionPolicy CRUD", () => {
        it("upserts and gets policy", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
                keypair_public: "PUB",
                keypair_source: "SRC"
            });
            
            let p = repo.getExtensionPolicy(db, "C1");
            expect(p?.target_ttl_ledgers).toBe(10000);
            expect(p?.enabled).toBe(1);

            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: false,
                target_ttl_ledgers: 20000,
                extend_when_below_ledgers: 10000
            });
            p = repo.getExtensionPolicy(db, "C1");
            expect(p?.target_ttl_ledgers).toBe(20000);
            expect(p?.enabled).toBe(0);
        });
    });

    describe("AlertConfig and Fired Alerts", () => {
        it("inserts configs and gets them", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertAlertConfig(db, {
                contract_id: "C1",
                channel_type: "slack",
                channel_target: "T1",
                threshold_ledgers: 100,
                webhook_secret: "sec"
            });

            const configs = repo.getAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            
            const config = repo.getAlertConfigById(db, configs[0].id);
            expect(config?.channel_target).toBe("T1");

            repo.deleteAlertConfig(db, configs[0].id);
            expect(repo.getAlertConfigsForContract(db, "C1").length).toBe(0);
        });

        it("records fired alerts and resolves them", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "wasm" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;
            
            repo.insertAlertConfig(db, { contract_id: "C1", channel_type: "slack", channel_target: "T1", threshold_ledgers: 100 });
            const configId = repo.getAlertConfigsForContract(db, "C1")[0].id;

            repo.recordAlertFired(db, {
                alert_config_id: configId,
                contract_entry_id: entryId,
                fired_at_ledger: 1000,
                ttl_at_fire: 100
            });

            expect(repo.hasUnresolvedAlert(db, configId, entryId)).toBe(true);

            repo.resolveAlerts(db, entryId);
            expect(repo.hasUnresolvedAlert(db, configId, entryId)).toBe(false);
            
            const history = repo.getAlertHistory(db, "C1");
            expect(history.length).toBe(1);
            expect(history[0].resolved).toBe(1);

            let historyLimit = repo.getAlertHistory(db, "C1", 1);
            expect(historyLimit.length).toBe(1);
        });

        it("handles alert delivery logic", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "wasm" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;
            repo.insertAlertConfig(db, { contract_id: "C1", channel_type: "webhook", channel_target: "T1", threshold_ledgers: 100 });
            const configId = repo.getAlertConfigsForContract(db, "C1")[0].id;
            repo.recordAlertFired(db, { alert_config_id: configId, contract_entry_id: entryId, fired_at_ledger: 1000, ttl_at_fire: 100 });

            const alertHist = repo.getAlertHistory(db, "C1");
            expect(alertHist.length).toBe(1);
            let undelivered = repo.getUndeliveredAlerts(db, "testnet");
            expect(undelivered.length).toBe(1);
            
            repo.incrementRetryCount(db, undelivered[0].alertFiredId);
            undelivered = repo.getUndeliveredAlerts(db, "testnet");
            expect(undelivered[0].retryCount).toBe(1);

            repo.markAlertDelivered(db, undelivered[0].alertFiredId);
            undelivered = repo.getUndeliveredAlerts(db, "testnet");
            expect(undelivered.length).toBe(0);
        });
    });

    describe("Extension History & Cost Snapshots", () => {
        it("records extensions and retrieves them", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            repo.recordExtension(db, {
                contract_id: "C1",
                contract_entry_id: entryId,
                old_ttl_ledgers: 100,
                new_ttl_ledgers: 1000,
                tx_hash: "hash1",
                cost_xlm: 1.5,
                cpu_insns: 10000,
                mem_bytes: 2048,
                is_anomaly: true,
                executed_at_ledger: 500
            });

            const hist = repo.getExtensionHistory(db, "C1");
            expect(hist.length).toBe(1);
            expect(hist[0].cost_xlm).toBe(1.5);
            expect(hist[0].cpu_insns).toBe(10000);
            
            const histDays = repo.getExtensionHistory(db, "C1", 7);
            expect(histDays.length).toBe(1);

            const avg = repo.getAverageResourceUsage(db, "C1");
            expect(avg?.avg_cpu_insns).toBe(10000);
            expect(avg?.avg_mem_bytes).toBe(2048);

            const avgLimit = repo.getAverageResourceUsage(db, "C1", 1);
            expect(avgLimit?.count).toBe(1);
        });

        it("aggregates daily snapshots", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            // Make it so executed_at is in the past
            db.prepare(`
                INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 day'))
            `).run("C1", entryId, 10, 100, "tx1", 2.0, 0, 0, 0, 100);

            repo.aggregateDailyCostSnapshots(db);
            const snaps = repo.getCostDailySnapshots(db, "C1");
            expect(snaps.length).toBe(1);
            
            const snapsDays = repo.getCostDailySnapshots(db, "C1", 7);
            expect(snapsDays.length).toBe(1);

            const summary = repo.getContractCostSummary(db, "C1");
            expect(summary.total_cost_xlm).toBe(2.0);

            const summaryDays = repo.getContractCostSummary(db, "C1", 7);
            expect(summaryDays.total_cost_xlm).toBe(2.0);
        });
        
        it("returns empty cost summary when there are no extensions", () => {
             const summary = repo.getContractCostSummary(db, "NONEXISTENT");
             expect(summary.total_extensions).toBe(0);
             expect(summary.total_cost_xlm).toBe(0);
        });
        
        it("handles empty average resource usage", () => {
             expect(repo.getAverageResourceUsage(db, "NONEXISTENT")).toBeNull();
        });
    });

    describe("Channel Accounts", () => {
        it("crud channel accounts", () => {
            repo.insertChannelAccount(db, { public_key: "PUB1", network: "testnet" });
            repo.upsertChannelAccount(db, { public_key: "PUB1", keypair_source: "SRC1", network: "testnet" });
            repo.upsertChannelAccount(db, { public_key: "PUB2", keypair_source: "SRC2", network: "testnet" });

            const accounts = repo.getChannelAccounts(db, "testnet");
            expect(accounts.length).toBe(2);

            repo.updateChannelBalance(db, "PUB1", 10.5);
            repo.markChannelFunded(db, "PUB1");

            repo.deleteChannelAccount(db, "PUB2");
            const accounts2 = repo.getChannelAccounts(db, "testnet");
            expect(accounts2.length).toBe(1);
            expect(accounts2[0].balance_xlm).toBe(10.5);
            expect(accounts2[0].funded).toBe(1);
        });
    });

    describe("State Snapshots and Changes", () => {
        it("inserts and gets snapshots and changes", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            const snapId1 = repo.insertStateSnapshot(db, {
                contract_entry_id: entryId,
                snapshot_ledger: 1000,
                value_hash: "hash1",
                value_xdr: "xdr_val_1"
            });
            const latest1 = repo.getLatestSnapshot(db, entryId);
            expect(latest1?.id).toBe(snapId1);

            const snapId2 = repo.insertStateSnapshot(db, {
                contract_entry_id: entryId,
                snapshot_ledger: 1001,
                value_hash: "hash2",
                value_xdr: "xdr_val_2"
            });
            const latest2 = repo.getLatestSnapshot(db, entryId);
            expect(latest2?.id).toBe(snapId2);

            const changeId = repo.insertStateChange(db, {
                contract_entry_id: entryId,
                old_snapshot_id: snapId1,
                new_snapshot_id: snapId2,
                diff_type: "updated",
                diff_json: "{}",
                detected_at_ledger: 1001
            });
            expect(changeId).toBeGreaterThan(0);

            const changes = repo.getStateChanges(db, entryId);
            expect(changes.length).toBe(1);
            
            const changesLimit = repo.getStateChanges(db, entryId, 1);
            expect(changesLimit.length).toBe(1);
            
            expect(() => repo.getStateChanges(db, entryId, -1)).toThrow("limit must be non-negative");
        });
    });

    describe("Resource Alerts Config & Fired", () => {
        it("crud resource alert configs and records fired", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertResourceAlertConfig(db, {
                contract_id: "C1",
                channel_type: "slack",
                channel_target: "T1",
                cpu_limit: 80,
                mem_limit: 90
            });
            
            const configs = repo.getResourceAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            
            const conf = repo.getResourceAlertConfigById(db, configs[0].id);
            expect(conf?.cpu_limit).toBe(80);

            const alertFiredId = repo.recordResourceAlertFired(db, {
                resource_alert_config_id: conf!.id,
                resource_type: "cpu",
                usage: 85,
                limit: 80,
                usage_percent: 106,
                fired_at_ledger: 1000
            });

            expect(repo.hasUnresolvedResourceAlert(db, conf!.id, "cpu")).toBe(true);
            expect(repo.hasUnresolvedResourceAlert(db, conf!.id, "cpu", 100)).toBe(true);
            expect(repo.hasUnresolvedResourceAlert(db, conf!.id, "cpu", 110)).toBe(false);

            repo.markResourceAlertDelivered(db, alertFiredId);
            repo.incrementResourceAlertRetryCount(db, alertFiredId);

            const hist = repo.getResourceUsageHistory(db, "C1");
            expect(hist.length).toBe(1);
            
            const histDays = repo.getResourceUsageHistory(db, "C1", 7);
            expect(histDays.length).toBe(1);

            let undelivered = repo.getUndeliveredResourceAlerts(db, "testnet");
            expect(undelivered.length).toBe(0); // already delivered
            
            // record new undelivered
            repo.recordResourceAlertFired(db, {
                resource_alert_config_id: conf!.id,
                resource_type: "memory",
                usage: 95,
                limit: 90,
                usage_percent: 105,
                fired_at_ledger: 1000
            });
            undelivered = repo.getUndeliveredResourceAlerts(db, "testnet");
            expect(undelivered.length).toBe(1);

            repo.deleteResourceAlertConfig(db, conf!.id);
            expect(repo.getResourceAlertConfigsForContract(db, "C1").length).toBe(0);
        });
    });
});
