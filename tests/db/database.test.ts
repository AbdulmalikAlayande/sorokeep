import { describe, it, expect, afterEach, vi } from "vitest";
import { getDatabase, closeDatabase, vacuumDatabase, getDatabaseForTesting } from "../../src/db/database";
import fs from "fs";
import path from "path";

describe("Database core functions", () => {
    afterEach(() => {
        closeDatabase();
        vi.restoreAllMocks();
    });

    describe("getDatabase", () => {
        it("creates and returns a singleton database", () => {
            const db1 = getDatabase();
            const db2 = getDatabase();
            expect(db1).toBe(db2);
            expect(db1).toBeDefined();
        });

        it("allows custom path", () => {
            const customPath = path.join(process.cwd(), "test-db-custom.sqlite");
            if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
            
            closeDatabase();
            const db = getDatabase(customPath);
            expect(db).toBeDefined();
            expect(fs.existsSync(customPath)).toBe(true);
            
            closeDatabase();
            if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
        });
    });

    describe("closeDatabase", () => {
        it("closes an active database", () => {
            const db = getDatabase();
            expect(db.open).toBe(true);
            closeDatabase();
            expect(db.open).toBe(false);
        });
        
        it("does nothing if db is already closed or null", () => {
            closeDatabase();
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    describe("vacuumDatabase", () => {
        it("runs VACUUM command", () => {
            const db = getDatabaseForTesting();
            const result = vacuumDatabase(db);
            expect(result).toBe(true);
            db.close();
        });

        it("returns false if db is in a transaction", () => {
            const db = getDatabaseForTesting();
            db.exec("BEGIN TRANSACTION");
            const result = vacuumDatabase(db);
            expect(result).toBe(false);
            db.exec("COMMIT");
            db.close();
        });

    it("should record fired alerts and check resolution status", () => {
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);

        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 12345,
            ttl_at_fire: 450,
        });

        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(true);
    });

    it("should resolve alerts for a specific entry", () => {
        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 12345,
            ttl_at_fire: 450,
        });

        resolveAlerts(db, contractEntryID, contractAlertConfigID);
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
    });

    it("should resolve only the targeted alert configuration for an entry", () => {
        insertAlertConfig(db, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://other.example.com",
            threshold_ledgers: 1000,
        });
        const configs = getAlertConfigsForContract(db, contractID);
        const secondConfigId = configs.find(c => c.threshold_ledgers === 1000)!.id;

        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 100,
            ttl_at_fire: 400,
        });
        recordAlertFired(db, {
            alert_config_id: secondConfigId,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 100,
            ttl_at_fire: 400,
        });

        resolveAlerts(db, contractEntryID, contractAlertConfigID);

        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
        expect(hasUnresolvedAlert(db, secondConfigId, contractEntryID)).toBe(true);
    });

    it('should only resolve alerts for the specific entry', () => {
        // Create another entry
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "ANOTHER_ENTRY",
            entry_type: "persistent",
        });
        const anotherEntryID = getEntriesForContract(db, contractID).find(e => e.entry_key_xdr === "ANOTHER_ENTRY")!.id;

        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 100,
            ttl_at_fire: 10,
        });
        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: anotherEntryID,
            fired_at_ledger: 100,
            ttl_at_fire: 10,
        });

        resolveAlerts(db, contractEntryID, contractAlertConfigID);
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
        expect(hasUnresolvedAlert(db, contractAlertConfigID, anotherEntryID)).toBe(true);
    });

    it("should resolve alerts when resolveAlerts is called after TTL is extended", () => {
        recordAlertFired(db, {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 100,
            ttl_at_fire: 450,
        });
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(true);

        // Simulate TTL extension by upserting with a higher TTL
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "XDR_KEY_1",
            entry_type: "instance",
            live_until_ledger: 2000,
        });

        // Resolve the alerts for this entry (monitor would trigger this on the next cycle)
        resolveAlerts(db, contractEntryID, contractAlertConfigID);

        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
    });
});

// --------------------- Database Operations Tests For Extension History ---------------------
describe("Extension History Operations", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let entryID: number;

    beforeEach(() => {
        insertContract(db, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "XDR_KEY_1",
            entry_type: "instance",
            live_until_ledger: 1000,
        });
        const entries = getEntriesForContract(db, contractID);
        entryID = entries[0]!.id;
    });

    it("should record and retrieve extension history", () => {
        const record = {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash123",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        };
        recordExtension(db, record);

        const history = getExtensionHistory(db, contractID);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash123",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        });
    });

    it.skip("TODO: Implement aggregate cost tracking by contract", () => {
        // This is a Phase 2 feature mentioned in the roadmap
    });

    it.skip("TODO: Implement resource usage tracking (CPU/Memory)", () => {
        // This is a Phase 2 feature mentioned in the roadmap
    });

    it("should filter history by days", () => {
        recordExtension(db, {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 100,
            new_ttl_ledgers: 200,
            tx_hash: "old_hash",
            executed_at_ledger: 10,
        });
        
        // Manually update executed_at to be old
        db.prepare("UPDATE extension_history SET executed_at = datetime('now', '-10 days') WHERE tx_hash = 'old_hash'").run();

        recordExtension(db, {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 200,
            new_ttl_ledgers: 300,
            tx_hash: "new_hash",
            executed_at_ledger: 20,
        });

        const all = getExtensionHistory(db, contractID);
        expect(all).toHaveLength(2);

        const recent = getExtensionHistory(db, contractID, 5);
        expect(recent).toHaveLength(1);
        expect(recent[0]!.tx_hash).toBe("new_hash");
    });

    it("aggregates daily snapshots and uses them for contract cost summary", () => {
        recordExtension(db, {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 100,
            new_ttl_ledgers: 200,
            tx_hash: "snapshot_hash_1",
            cost_xlm: 0.25,
            executed_at_ledger: 10,
        });

        recordExtension(db, {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 200,
            new_ttl_ledgers: 300,
            tx_hash: "snapshot_hash_2",
            cost_xlm: 0.50,
            executed_at_ledger: 20,
        });

        // Force one snapshot row to be older than today.
        db.prepare("UPDATE extension_history SET executed_at = datetime('now', '-1 day') WHERE tx_hash = 'snapshot_hash_1'").run();
        db.prepare("UPDATE extension_history SET executed_at = datetime('now', '-2 days') WHERE tx_hash = 'snapshot_hash_2'").run();

        aggregateDailyCostSnapshots(db);

        const snapshots = getCostDailySnapshots(db, contractID, 5);
        expect(snapshots.length).toBe(2);
        expect(snapshots[0]!.total_cost_xlm).toBeCloseTo(0.25, 7);
        expect(snapshots[1]!.total_cost_xlm).toBeCloseTo(0.50, 7);

        const summary = getContractCostSummary(db, contractID, 5);
        expect(summary.total_extensions).toBe(2);
        expect(summary.total_cost_xlm).toBeCloseTo(0.75, 7);
        expect(summary.byType.instance.cost_xlm).toBeCloseTo(0.75, 7);
        expect(summary.byType.instance.count).toBe(2);
        expect(summary.byType.wasm.count).toBe(0);
        expect(summary.byType.persistent.count).toBe(0);
        expect(summary.byType.temporary.count).toBe(0);
    });
    it("should calculate average resource usage", () => {
        const record = {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash123",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        };

        // Record a few extensions with resource usage
        recordExtension(db, { ...record, tx_hash: "h1", cpu_insns: 1000, mem_bytes: 100 });
        recordExtension(db, { ...record, tx_hash: "h2", cpu_insns: 1200, mem_bytes: 110 });
        recordExtension(db, { ...record, tx_hash: "h3", cpu_insns: 800, mem_bytes: 90 });
        
        // Record one without usage to ensure it's ignored
        recordExtension(db, { ...record, tx_hash: "h4", cpu_insns: null, mem_bytes: null });

        const avg = getAverageResourceUsage(db, contractID);
        expect(avg).toBeDefined();
        expect(avg!.avg_cpu_insns).toBeCloseTo((1000 + 1200 + 800) / 3); // 1000
        expect(avg!.avg_mem_bytes).toBeCloseTo((100 + 110 + 90) / 3); // 100
        expect(avg!.count).toBe(3);
    });

    it("should return null for average usage if no history exists", () => {
        const avg = getAverageResourceUsage(db, contractID);
        expect(avg).toBeNull();
    });

    it("should respect the limit for average calculation", () => {
        const record = {
            contract_id: contractID,
            contract_entry_id: entryID,
            old_ttl_ledgers: 1000,
            new_ttl_ledgers: 50000,
            tx_hash: "hash123",
            cost_xlm: 0.5,
            executed_at_ledger: 12345,
        };

        // Oldest
        recordExtension(db, { ...record, tx_hash: "h1", cpu_insns: 100, mem_bytes: 10 });
        // Newer
        recordExtension(db, { ...record, tx_hash: "h2", cpu_insns: 1000, mem_bytes: 100 });
        recordExtension(db, { ...record, tx_hash: "h3", cpu_insns: 1200, mem_bytes: 110 });

        const avg = getAverageResourceUsage(db, contractID, 2); // Only last 2
        expect(avg).toBeDefined();
        expect(avg!.avg_cpu_insns).toBeCloseTo((1000 + 1200) / 2); // 1100
        expect(avg!.avg_mem_bytes).toBeCloseTo((100 + 110) / 2); // 105
    });
});

// --------------------- Database Operations Tests For State Snapshots & Changes ---------------------
describe("State Snapshots & Changes Operations", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let entryID: number;

    beforeEach(() => {
        insertContract(db, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "XDR_KEY_1",
            entry_type: "instance",
            live_until_ledger: 1000,
        });
        const entries = getEntriesForContract(db, contractID);
        entryID = entries[0]!.id;
    });

    it("inserts a state snapshot and retrieves the latest", () => {
        const snapshot1 = {
            contract_entry_id: entryID,
            snapshot_ledger: 100,
            value_hash: "hash1",
            value_xdr: "xdr1"
        };
        const id1 = insertStateSnapshot(db, snapshot1);
        expect(id1).toBeGreaterThan(0);

        const snapshot2 = {
            contract_entry_id: entryID,
            snapshot_ledger: 200,
            value_hash: "hash2",
            value_xdr: "xdr2"
        };
        insertStateSnapshot(db, snapshot2);

        const latest = getLatestSnapshot(db, entryID);
        expect(latest).toBeDefined();
        expect(latest!.snapshot_ledger).toBe(200);
        expect(latest!.value_hash).toBe("hash2");
        expect(latest!.value_xdr).toBe("xdr2");
    });

    it("inserts a state change and retrieves changes", () => {
        const snapshotId1 = insertStateSnapshot(db, {
            contract_entry_id: entryID,
            snapshot_ledger: 100,
            value_hash: "hash1",
            value_xdr: "xdr1"
        });
        
        const snapshotId2 = insertStateSnapshot(db, {
            contract_entry_id: entryID,
            snapshot_ledger: 200,
            value_hash: "hash2",
            value_xdr: "xdr2"
        });

        const change1 = {
            contract_entry_id: entryID,
            old_snapshot_id: snapshotId1,
            new_snapshot_id: snapshotId2,
            diff_type: "updated",
            diff_json: "{}",
            detected_at_ledger: 200
        };
        insertStateChange(db, change1);

        const changes = getStateChanges(db, entryID);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.diff_type).toBe("updated");
        expect(changes[0]!.detected_at_ledger).toBe(200);
    });

    it("cascades delete when an entry is removed", () => {
        insertStateSnapshot(db, {
            contract_entry_id: entryID,
            snapshot_ledger: 100,
            value_hash: "hash1",
            value_xdr: "xdr1"
        it("returns false if database is locked/busy", () => {
            const db = getDatabaseForTesting();
            const originalExec = db.exec.bind(db);
            db.exec = vi.fn().mockImplementation((sql: string) => {
                if (sql === "VACUUM") {
                    throw new Error("database is locked");
                }
                return originalExec(sql);
            });
            const result = vacuumDatabase(db);
            expect(result).toBe(false);
            db.close();
        });

        it("throws if an unknown error occurs during VACUUM", () => {
            const db = getDatabaseForTesting();
            const originalExec = db.exec.bind(db);
            db.exec = vi.fn().mockImplementation((sql: string) => {
                if (sql === "VACUUM") {
                    throw new Error("Unknown error");
                }
                return originalExec(sql);
            });
            expect(() => vacuumDatabase(db)).toThrow("Unknown error");
            db.close();
        });
    });
});
