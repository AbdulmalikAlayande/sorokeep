import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import * as repo from "../../src/db/repositories.js";

describe("Database Repositories", () => {
    let db: any;

    beforeEach(() => {
        // getDatabaseForTesting() execs the current schema.sql directly into a
        // fresh :memory: database, so it already has every column/table/CHECK
        // schema.sql defines — no need to replay ad-hoc migrations here.
        db = getDatabaseForTesting();
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

    describe("Contract Tags", () => {
        it("adds a tag to a contract with no existing tags", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            const tags = repo.addContractTag(db, "C1", "defi");
            expect(tags).toEqual(["defi"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("defi");
        });

        it("appends a new tag to existing tags using the comma-separated format", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "nft" });
            const tags = repo.addContractTag(db, "C1", "defi");
            expect(tags).toEqual(["nft", "defi"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("nft,defi");
        });

        it("adding a tag that already exists is a no-op, not a duplicate", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "defi" });
            const tags = repo.addContractTag(db, "C1", "defi");
            expect(tags).toEqual(["defi"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("defi");
        });

        it("trims surrounding whitespace when adding a tag", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            const tags = repo.addContractTag(db, "C1", "  defi  ");
            expect(tags).toEqual(["defi"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("defi");
        });

        it("produces a clear error when adding a tag to an unregistered contract", () => {
            expect(() => repo.addContractTag(db, "MISSING", "defi")).toThrow(/not registered/i);
        });

        it("removes an existing tag", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "defi,nft" });
            const tags = repo.removeContractTag(db, "C1", "defi");
            expect(tags).toEqual(["nft"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("nft");
        });

        it("removing a tag that is not present does not error and leaves tags unchanged", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "nft" });
            const tags = repo.removeContractTag(db, "C1", "defi");
            expect(tags).toEqual(["nft"]);
            expect(repo.getContract(db, "C1")?.tags).toBe("nft");
        });

        it("removing the last tag resets the tags column to null", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "defi" });
            const tags = repo.removeContractTag(db, "C1", "defi");
            expect(tags).toEqual([]);
            expect(repo.getContract(db, "C1")?.tags).toBeNull();
        });

        it("produces a clear error when removing a tag from an unregistered contract", () => {
            expect(() => repo.removeContractTag(db, "MISSING", "defi")).toThrow(/not registered/i);
        });

        it("keeps tags interoperable with the exact-match --tag filter format", () => {
            repo.insertContract(db, { id: "C1", network: "testnet", tags: "defi" });
            repo.addContractTag(db, "C1", "nft");

            // Stored format must be a trimmed, comma-separated string so an
            // exact-match tag filter finds it.
            expect(repo.getContract(db, "C1")?.tags).toBe("defi,nft");
            repo.removeContractTag(db, "C1", "defi");
            expect(repo.getContract(db, "C1")?.tags).toBe("nft");
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

    describe("Entry-type policy overrides (#491)", () => {
        it("falls back to the contract-level policy when no override exists", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
            });

            const effective = repo.getEffectivePolicy(db, "C1", "persistent");
            expect(effective?.target_ttl_ledgers).toBe(10000);
            expect(effective?.extend_when_below_ledgers).toBe(5000);
        });

        it("returns override TTL parameters while inheriting enabled/keypair from the contract-level policy", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
                keypair_public: "PUB",
                keypair_source: "SRC",
            });
            repo.setEntryTypePolicy(db, "C1", "temporary", {
                target_ttl_ledgers: 500,
                extend_when_below_ledgers: 100,
            });

            const effective = repo.getEffectivePolicy(db, "C1", "temporary");
            expect(effective?.target_ttl_ledgers).toBe(500);
            expect(effective?.extend_when_below_ledgers).toBe(100);
            expect(effective?.enabled).toBe(1);
            expect(effective?.keypair_public).toBe("PUB");

            // Other entry types are unaffected by the override.
            const untouched = repo.getEffectivePolicy(db, "C1", "instance");
            expect(untouched?.target_ttl_ledgers).toBe(10000);
        });

        it("does not force-enable auto-extension when the contract-level policy is disabled", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: false,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
            });
            repo.setEntryTypePolicy(db, "C1", "wasm", {
                target_ttl_ledgers: 500,
                extend_when_below_ledgers: 100,
            });

            const effective = repo.getEffectivePolicy(db, "C1", "wasm");
            expect(effective?.enabled).toBe(0);
        });

        it("upserts an override in place when set again for the same entry type", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
            });
            repo.setEntryTypePolicy(db, "C1", "persistent", { target_ttl_ledgers: 500, extend_when_below_ledgers: 100 });
            repo.setEntryTypePolicy(db, "C1", "persistent", { target_ttl_ledgers: 800, extend_when_below_ledgers: 200 });

            const effective = repo.getEffectivePolicy(db, "C1", "persistent");
            expect(effective?.target_ttl_ledgers).toBe(800);
            expect(effective?.extend_when_below_ledgers).toBe(200);
        });

        it("removes an override, reverting to the contract-level policy", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertExtensionPolicy(db, {
                contract_id: "C1",
                enabled: true,
                target_ttl_ledgers: 10000,
                extend_when_below_ledgers: 5000,
            });
            repo.setEntryTypePolicy(db, "C1", "persistent", { target_ttl_ledgers: 500, extend_when_below_ledgers: 100 });
            repo.deleteEntryTypePolicy(db, "C1", "persistent");

            const effective = repo.getEffectivePolicy(db, "C1", "persistent");
            expect(effective?.target_ttl_ledgers).toBe(10000);
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

            repo.resolveAlerts(db, entryId, configId);
            expect(repo.hasUnresolvedAlert(db, configId, entryId)).toBe(false);
            
            const history = repo.getAlertHistory(db, "C1");
            expect(history.length).toBe(1);
            expect(history[0].resolved).toBe(1);

            let historyLimit = repo.getAlertHistory(db, "C1", 1);
            expect(historyLimit.length).toBe(1);
        });

        it("accepts discord as a valid channel_type for alert_configs", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertAlertConfig(db, {
                contract_id: "C1",
                channel_type: "discord",
                channel_target: "https://discord.com/api/webhooks/123",
                threshold_ledgers: 200
            });

            const configs = repo.getAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            expect(configs[0].channel_type).toBe("discord");
            expect(configs[0].channel_target).toBe("https://discord.com/api/webhooks/123");
        });

        it("accepts telegram as a valid channel_type for alert_configs", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertAlertConfig(db, {
                contract_id: "C1",
                channel_type: "telegram",
                channel_target: "chat:123456",
                threshold_ledgers: 300
            });

            const configs = repo.getAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            expect(configs[0].channel_type).toBe("telegram");
            expect(configs[0].channel_target).toBe("chat:123456");
        });

        it("accepts an arbitrary plugin channel_type not in the built-in set", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertAlertConfig(db, {
                contract_id: "C1",
                channel_type: "matrix",
                channel_target: "!room:example.org",
                threshold_ledgers: 400,
            });

            const configs = repo.getAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            expect(configs[0].channel_type).toBe("matrix");
        });

        it("rejects an empty channel_type", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            expect(() =>
                repo.insertAlertConfig(db, {
                    contract_id: "C1",
                    channel_type: "",
                    channel_target: "T1",
                    threshold_ledgers: 100,
                }),
            ).toThrow();
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

        it("computes channel delivery stats correctly", () => {
            repo.insertContract(db, { id: "C2", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C2", entry_key_xdr: "xdr2", entry_type: "wasm" });
            const entryId = repo.getEntriesForContract(db, "C2")[0].id;

            // Multiple configs for same channel type
            repo.insertAlertConfig(db, { contract_id: "C2", channel_type: "slack", channel_target: "C_A", threshold_ledgers: 100 });
            repo.insertAlertConfig(db, { contract_id: "C2", channel_type: "slack", channel_target: "C_B", threshold_ledgers: 100 });
            
            const configs = repo.getAlertConfigsForContract(db, "C2");
            const configIdA = configs[0].id;
            const configIdB = configs[1].id;

            // We need 10 attempts total: 8 delivered, 2 abandoned (retry_count >= 5)
            // 5 delivered for config A
            for (let i = 0; i < 5; i++) {
                repo.recordAlertFired(db, { alert_config_id: configIdA, contract_entry_id: entryId, fired_at_ledger: 1000, ttl_at_fire: 100 });
            }
            // 3 delivered for config B
            for (let i = 0; i < 3; i++) {
                repo.recordAlertFired(db, { alert_config_id: configIdB, contract_entry_id: entryId, fired_at_ledger: 1000, ttl_at_fire: 100 });
            }
            
            // Mark the first 8 as delivered
            const history = repo.getAlertHistory(db, "C2");
            for (let i = 0; i < 8; i++) {
                repo.markAlertDelivered(db, history[i].alertFiredId);
            }

            // 2 abandoned for config A
            for (let i = 0; i < 2; i++) {
                repo.recordAlertFired(db, { alert_config_id: configIdA, contract_entry_id: entryId, fired_at_ledger: 1000, ttl_at_fire: 100 });
            }

            // Increment retry_count to 5 for the abandoned ones
            const historyAfterAbandoned = repo.getAlertHistory(db, "C2");
            const undelivered = historyAfterAbandoned.filter(a => a.delivered === 0);
            for (const alert of undelivered) {
                for (let r = 0; r < 5; r++) {
                    repo.incrementRetryCount(db, alert.alertFiredId);
                }
            }

            const stats = repo.getChannelDeliveryStats(db, "slack");
            expect(stats).toBeDefined();
            expect(stats.totalAttempts).toBe(10);
            expect(stats.deliveredCount).toBe(8);
            expect(stats.abandonedCount).toBe(2);
            expect(stats.failedCount).toBe(0);
            expect(stats.successRate).toBe(80);
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

        it("returns null when limit is explicitly 0", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            repo.recordExtension(db, {
                contract_id: "C1",
                contract_entry_id: entryId,
                old_ttl_ledgers: 100,
                new_ttl_ledgers: 1000,
                tx_hash: "hash_zero",
                cost_xlm: 1.0,
                cpu_insns: 5000,
                mem_bytes: 1024,
                is_anomaly: false,
                executed_at_ledger: 500
            });

            const avg = repo.getAverageResourceUsage(db, "C1", 0);
            expect(avg).toBeNull();
        });

        it("returns correct averages when limit equals total records", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            repo.recordExtension(db, {
                contract_id: "C1",
                contract_entry_id: entryId,
                old_ttl_ledgers: 100,
                new_ttl_ledgers: 1000,
                tx_hash: "hash_a",
                cost_xlm: 1.0,
                cpu_insns: 2000,
                mem_bytes: 512,
                is_anomaly: false,
                executed_at_ledger: 500
            });
            repo.recordExtension(db, {
                contract_id: "C1",
                contract_entry_id: entryId,
                old_ttl_ledgers: 200,
                new_ttl_ledgers: 2000,
                tx_hash: "hash_b",
                cost_xlm: 2.0,
                cpu_insns: 4000,
                mem_bytes: 1024,
                is_anomaly: false,
                executed_at_ledger: 600
            });

            const avg = repo.getAverageResourceUsage(db, "C1", 2);
            expect(avg).not.toBeNull();
            expect(avg?.count).toBe(2);
            expect(avg?.avg_cpu_insns).toBe(3000);
            expect(avg?.avg_mem_bytes).toBe(768);
        });

        it("only aggregates extension history from the last 7 days", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            // Insert an old entry from 30 days ago — should NOT be aggregated
            db.prepare(`
                INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 days'))
            `).run("C1", entryId, 10, 100, "tx_old", 5.0, 0, 0, 0, 100);

            // Insert a recent entry from 3 days ago — should be aggregated
            db.prepare(`
                INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 days'))
            `).run("C1", entryId, 10, 100, "tx_recent", 3.0, 0, 0, 0, 200);

            repo.aggregateDailyCostSnapshots(db);
            const snaps = repo.getCostDailySnapshots(db, "C1");

            // Only the 3-day-old entry should produce a snapshot
            expect(snaps.length).toBe(1);
            expect(snaps[0].total_cost_xlm).toBe(3.0);
        });

        it("returns average of only the most recent row when limit is 1", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.upsertEntry(db, { contract_id: "C1", entry_key_xdr: "xdr1", entry_type: "instance" });
            const entryId = repo.getEntriesForContract(db, "C1")[0].id;

            // Insert an older extension
            db.prepare(`
                INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'))
            `).run("C1", entryId, 100, 1000, "hash_old", 1.0, 2000, 512, 0, 500);

            // Insert a newer extension
            db.prepare(`
                INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'))
            `).run("C1", entryId, 200, 2000, "hash_new", 2.0, 8000, 4096, 0, 600);

            const avg = repo.getAverageResourceUsage(db, "C1", 1);
            expect(avg).not.toBeNull();
            expect(avg?.count).toBe(1);
            expect(avg?.avg_cpu_insns).toBe(8000);
            expect(avg?.avg_mem_bytes).toBe(4096);
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
        it("accepts an arbitrary plugin channel_type not in the built-in set", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertResourceAlertConfig(db, {
                contract_id: "C1",
                channel_type: "matrix",
                channel_target: "!room:example.org",
                cpu_limit: 50,
                mem_limit: 50,
            });

            const configs = repo.getResourceAlertConfigsForContract(db, "C1");
            expect(configs.length).toBe(1);
            expect(configs[0].channel_type).toBe("matrix");
        });

    describe("Contract Groups", () => {
        it("creates a group and gets contracts in it", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertContract(db, { id: "C2", network: "testnet" });

            const groupId = repo.createGroup(db, { name: "My Fleet" });
            expect(groupId).toBeGreaterThan(0);

            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C1" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C2" });

            const contracts = repo.getContractsInGroup(db, groupId);
            expect(contracts.length).toBe(2);
            expect(contracts.map(c => c.id).sort()).toEqual(["C1", "C2"]);
        });

        it("removes a contract from a group", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertContract(db, { id: "C2", network: "testnet" });

            const groupId = repo.createGroup(db, { name: "Fleet" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C1" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C2" });

            repo.removeContractFromGroup(db, { group_id: groupId, contract_id: "C1" });

            const contracts = repo.getContractsInGroup(db, groupId);
            expect(contracts.length).toBe(1);
            expect(contracts[0].id).toBe("C2");
        });

        it("gets groups for a contract", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });

            const g1 = repo.createGroup(db, { name: "Group A" });
            const g2 = repo.createGroup(db, { name: "Group B" });

            repo.addContractToGroup(db, { group_id: g1, contract_id: "C1" });
            repo.addContractToGroup(db, { group_id: g2, contract_id: "C1" });

            const groups = repo.getGroupsForContract(db, "C1");
            expect(groups.length).toBe(2);
            expect(groups.map(g => g.name).sort()).toEqual(["Group A", "Group B"]);
        });

        it("deleting a contract removes its group memberships (cascade) without deleting the group", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertContract(db, { id: "C2", network: "testnet" });

            const groupId = repo.createGroup(db, { name: "Fleet" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C1" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C2" });

            repo.deleteContract(db, "C1");

            const contracts = repo.getContractsInGroup(db, groupId);
            expect(contracts.length).toBe(1);
            expect(contracts[0].id).toBe("C2");
        });

        it("deleting a group removes memberships without deleting the underlying contracts", () => {
            repo.insertContract(db, { id: "C1", network: "testnet" });
            repo.insertContract(db, { id: "C2", network: "testnet" });

            const groupId = repo.createGroup(db, { name: "Fleet" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C1" });
            repo.addContractToGroup(db, { group_id: groupId, contract_id: "C2" });

            // Delete the group via raw SQL (cascade automatically removes memberships)
            db.prepare("DELETE FROM contract_groups WHERE id = ?").run(groupId);

            // Both contracts should still exist
            expect(repo.getContract(db, "C1")).toBeDefined();
            expect(repo.getContract(db, "C2")).toBeDefined();

            // The group should be empty
            const contracts = repo.getContractsInGroup(db, groupId);
            expect(contracts.length).toBe(0);
        });
    });

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

    describe("getFleetCostRollup", () => {
        /**
         * Helper: seed a contract with one instance entry and one extension
         * recorded N days ago (so aggregateDailyCostSnapshots will pick it up).
         */
        function seedContractWithExtension(
            database: typeof db,
            contractId: string,
            name: string,
            tags: string | null,
            costXlm: number,
            daysAgo: number,
        ) {
            repo.insertContract(database, { id: contractId, name, network: "testnet", tags: tags ?? undefined });
            repo.upsertEntry(database, {
                contract_id: contractId,
                entry_key_xdr: `xdr-${contractId}`,
                entry_type: "instance",
                label: "instance",
                live_until_ledger: 500000,
                last_modified_ledger: 400000,
            });
            const entryRow = database
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
                .get(contractId) as { id: number };

            database.prepare(`
                INSERT INTO extension_history
                    (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                     tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly,
                     executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
            `).run(
                contractId,
                entryRow.id,
                10000,
                20000,
                `tx-${contractId}-${daysAgo}`,
                costXlm,
                0,
                1024,
                0,
                400001,
                `-${daysAgo} days`,
            );
        }

        it("returns zero totals when no snapshots exist", () => {
            const rollup = repo.getFleetCostRollup(db);
            expect(rollup.total_extensions).toBe(0);
            expect(rollup.total_cost_xlm).toBe(0);
            expect(rollup.contract_count).toBe(0);
            expect(rollup.byType.instance.cost_xlm).toBe(0);
            expect(rollup.byType.wasm.cost_xlm).toBe(0);
            expect(rollup.byType.persistent.cost_xlm).toBe(0);
            expect(rollup.byType.temporary.cost_xlm).toBe(0);
        });

        it("fleet total equals sum of individual contract costs (AC1)", () => {
            seedContractWithExtension(db, "CA", "Contract A", null, 1.5, 1);
            seedContractWithExtension(db, "CB", "Contract B", null, 2.5, 1);

            repo.aggregateDailyCostSnapshots(db);

            const summaryA = repo.getContractCostSummary(db, "CA");
            const summaryB = repo.getContractCostSummary(db, "CB");
            const expectedTotal = summaryA.total_cost_xlm + summaryB.total_cost_xlm;

            const rollup = repo.getFleetCostRollup(db);

            expect(rollup.total_cost_xlm).toBeCloseTo(expectedTotal, 7);
            expect(rollup.contract_count).toBe(2);
        });

        it("includes today's live extensions in fleet totals", () => {
            repo.insertContract(db, { id: "CT", name: "Today Contract", network: "testnet" });
            repo.upsertEntry(db, {
                contract_id: "CT",
                entry_key_xdr: "xdr-CT",
                entry_type: "instance",
                label: "instance",
                live_until_ledger: 500000,
                last_modified_ledger: 400000,
            });
            const entryRow = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
                .get("CT") as { id: number };

            db.prepare(`
                INSERT INTO extension_history
                    (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                     tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly,
                     executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run("CT", entryRow.id, 10000, 20000, "tx-today", 3.0, 0, 1024, 0, 400001);

            const rollup = repo.getFleetCostRollup(db);

            expect(rollup.total_cost_xlm).toBeCloseTo(3.0, 7);
            expect(rollup.total_extensions).toBe(1);
        });

        it("filters by tag — excludes contracts outside the tag set (AC2)", () => {
            seedContractWithExtension(db, "CA", "Contract A", "defi", 1.0, 1);
            seedContractWithExtension(db, "CB", "Contract B", "defi", 2.0, 1);
            seedContractWithExtension(db, "CC", "Contract C", "infra", 5.0, 1);

            repo.aggregateDailyCostSnapshots(db);

            const rollup = repo.getFleetCostRollup(db, { tag: "defi" });

            expect(rollup.total_cost_xlm).toBeCloseTo(3.0, 7);
            expect(rollup.contract_count).toBe(2);
        });

        it("tag filter with a comma-separated tags field matches correctly", () => {
            seedContractWithExtension(db, "CM", "Multi-tag", "defi,bridge", 4.0, 1);
            seedContractWithExtension(db, "CO", "Other", "infra", 1.0, 1);

            repo.aggregateDailyCostSnapshots(db);

            const rollup = repo.getFleetCostRollup(db, { tag: "defi" });

            expect(rollup.total_cost_xlm).toBeCloseTo(4.0, 7);
            expect(rollup.contract_count).toBe(1);
        });

        it("returns zero when tag filter matches no contracts", () => {
            seedContractWithExtension(db, "CA", "Contract A", "defi", 1.0, 1);
            repo.aggregateDailyCostSnapshots(db);

            const rollup = repo.getFleetCostRollup(db, { tag: "nonexistent-tag" });

            expect(rollup.total_cost_xlm).toBe(0);
            expect(rollup.contract_count).toBe(0);
        });

        it("respects the days filter to limit the rollup period", () => {
            seedContractWithExtension(db, "CA", "Contract A", null, 1.0, 3);
            seedContractWithExtension(db, "CB", "Contract B", null, 10.0, 20);

            repo.aggregateDailyCostSnapshots(db);

            const rollup7 = repo.getFleetCostRollup(db, { days: 7 });
            expect(rollup7.total_cost_xlm).toBeCloseTo(1.0, 7);

            const rollupAll = repo.getFleetCostRollup(db);
            // aggregateDailyCostSnapshots only captures the last 7 days, so
            // the 20-day-old extension is outside the snapshot window — only CA
            expect(rollupAll.total_cost_xlm).toBeCloseTo(1.0, 7);
        });

        it("includes per-entry-type breakdown at fleet level", () => {
            repo.insertContract(db, { id: "CW", name: "Wasm Contract", network: "testnet" });
            repo.upsertEntry(db, {
                contract_id: "CW",
                entry_key_xdr: "xdr-wasm-CW",
                entry_type: "wasm",
                label: "wasm",
                live_until_ledger: 500000,
                last_modified_ledger: 400000,
            });
            const wasmEntry = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
                .get("CW") as { id: number };

            db.prepare(`
                INSERT INTO extension_history
                    (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers,
                     tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly,
                     executed_at_ledger, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 day'))
            `).run("CW", wasmEntry.id, 10000, 20000, "tx-wasm", 3.0, 0, 1024, 0, 400001);

            seedContractWithExtension(db, "CI", "Instance Contract", null, 2.0, 1);

            repo.aggregateDailyCostSnapshots(db);

            const rollup = repo.getFleetCostRollup(db);

            expect(rollup.byType.wasm.cost_xlm).toBeCloseTo(3.0, 7);
            expect(rollup.byType.instance.cost_xlm).toBeCloseTo(2.0, 7);
            expect(rollup.byType.persistent.cost_xlm).toBe(0);
            expect(rollup.byType.temporary.cost_xlm).toBe(0);
        });
    });
});
