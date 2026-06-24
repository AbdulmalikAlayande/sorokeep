import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { 
    insertContract, 
    getContract, 
    getAllContracts, 
    updateLastCheckedLedger, 
    deleteContract, 
    upsertEntry, 
    getEntriesForContract, 
    upsertExtensionPolicy, 
    getExtensionPolicy,
    insertAlertConfig, 
    getAlertConfigsForContract, 
    deleteAlertConfig, 
    hasUnresolvedAlert, 
    recordAlertFired,
    resolveAlerts,
    recordExtension, 
    getAverageResourceUsage,
    getExtensionHistory
} from "../../src/db/repositories";
import { getDatabaseForTesting } from "../../src/db/database";

let db: Database.Database;

beforeEach(() => {
    db = getDatabaseForTesting();
});

// --------------------- Database Operations Tests For Contracts ---------------------

describe("Contract Operations", () => {
    // Test cases for contract operations
    it("inserts a new contract into the database and retrieves it", () => {
        const sampleContract = {
            id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
            name: "sample-contract",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract);
        const retrieved = getContract(db, sampleContract.id);
        expect(retrieved).toBeDefined();
        expect(retrieved).toMatchObject({
            ...sampleContract,
            registered_at: expect.any(String),
            last_checked_ledger: null,
        });
        expect(retrieved!.id).toBe(sampleContract.id);
        expect(retrieved!.name).toBe("sample-contract");
        expect(retrieved!.network).toBe("testnet");
        expect(retrieved!.last_checked_ledger).toBeNull();
        expect(retrieved!.registered_at).toBeDefined();
        expect(new Date(retrieved!.registered_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("returns undefined for non-existent contract", () => {
        const result = getContract(db, "DFGHT567YE0WOPM32S7K8L34DFHT536SD0OP")
        expect(result).toBeUndefined();
    });

    it("lists all contracts existing in the database", () => {
        const sampleContract2 = {
            id: "CBEK0975FU6KKOEZ7RMTSGTDELBS5D6LVATIGCESOGXSZEQ2UWQFKZW9",
            name: "sample-contract-2",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        };
        const sampleContract3 = {
            id: "CBD6LVA5FU6KKOEZ7RMTSKZ7YLBS5TYU7ETIGCESOGXSZEQ2UGTYUIW2",
            name: "sample-contract-3",
            network: "mainnet",
            wasm_hash: "aswer6543rfhnb234",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract2);
        insertContract(db, sampleContract3);

        const all = getAllContracts(db);
        expect(all).toHaveLength(2);
    });

    it("updates last checked ledger", () => {
        const sampleContract4 = {
            id: "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O",
            name: "sample-contract-4",
            network: "testnet",
            wasm_hash: "fsty361rfhnb442",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract4);
        updateLastCheckedLedger(db, sampleContract4.id, 12345678);

        const retrieved = getContract(db, sampleContract4.id);
        expect(retrieved!.last_checked_ledger).toBe(12345678);
    });

    it.skip("TODO: Implement contract discovery via getEvents", () => {
        // Phase 2 feature
    });

    it.skip("TODO: Implement contract health scoring", () => {
        // Phase 3 feature
    });

    it("deletes a contract from the database", () => {
        const sampleContract5 = {
            id: "CBEK0975FU6KKOEZ7RMTSGTDELBS5D6LVATIGCESOGXSZEQ2UWQFKZW9",
            name: "sample-contract-5",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract5);
        const allBefore = getAllContracts(db);
        expect(allBefore).toHaveLength(1);
        deleteContract(db, sampleContract5.id);
        const retrieved = getContract(db, sampleContract5.id);
        expect(retrieved).toBeUndefined();
        const allAfter = getAllContracts(db);
        expect(allAfter).toHaveLength(0);
    });

    it("upserts on duplicate contract ID", () => {
        const sampleContract6 = {
            id: "CBEK0975FU6KKOEZ7RMTSGTDELBS5D6LVATIGCESOGXSZEQ2UWQFKZW9",
            name: "sample-contract-6",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract6);
        const updatedContract = {
            ...sampleContract6,
            name: "updated-contract-6"
        };
        insertContract(db, updatedContract);
        const retrieved = getContract(db, sampleContract6.id);
        expect(retrieved).toBeDefined();
        expect(retrieved!.name).toBe("updated-contract-6");
    });
});

// --------------------- Database Operations Tests For Contract Entries ---------------------

describe("Contract Entry Operations", () => {
    // Test cases for contract entry operations
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    beforeEach(() => {
        insertContract(db, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        });
    })
    
    it("inserts a new contract entry and retrieves it", () => {
        const entryData = {
            contract_id: contractID,
            entry_key_xdr: "AAAAAgAAAADpL3ZlY3RvcgAAAAEAAAAAAAAAAQAAAAAAAAABAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAACAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAAD",
            entry_type: "instance",
            label: "contract-instance-1",
            live_until_ledger: 2_000_000,  
            last_modified_ledger: 19_500_000, 
            discovery_source: "manual",
        };
        upsertEntry(db, entryData);

        const entries = getEntriesForContract(db, contractID);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(entry!.entry_type).toBe("instance");
        expect(entry!.live_until_ledger).toBe(2000000);
        expect(entry!.label).toBe("contract-instance-1");
        expect(entry!.discovery_source).toBe("manual");
        expect(entry!.first_seen_at).toBeDefined();
    });

    it("upserts contract entry on duplicate contract_id and entry_key_xdr", () => {
        const commonEntryData = {
            entry_type: "instance",
            label: "contract-instance",
            live_until_ledger: 1_500_000,  
            last_modified_ledger: 18_500_000, 
            discovery_source: "manual",
        }
        upsertEntry(db, {
            ...commonEntryData,
            contract_id: contractID,
            entry_key_xdr: "WERTRYHD097DNND0NKKHDE1GYDGWJNW4LJW5676HUHE32727UBHJNKJDHG276346UC37637623782BS464LLPEOOD4778348835HVAGKGHDAEGD",
        });
        upsertEntry(db, {
            ...commonEntryData,
            contract_id: contractID,
            entry_key_xdr: "WERTRYHD097DNND0NKKHDE1GYDGWJNW4LJW5676HUHE32727UBHJNKJDHG276346UC37637623782BS464LLPEOOD4778348835HVAGKGHDAEGD",
        })

        const entries = getEntriesForContract(db, contractID);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.live_until_ledger).toBe(1_500_000);
    });

    it("stores multiple entries for one contract", () => {
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "AAAAAgAAAADpL3ZlY3RvcgAAAAEAAAAAAAAAAQAAAAAAAAABAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAACAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAAD",
            entry_type: "instance",
            label: "balances",
            live_until_ledger: 2_500_000,  
            last_modified_ledger: 11_000_000, 
            discovery_source: "manual",
        });
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "WERTRYHD097DNND0NKKHDE1GYDGWJNW4LJW5676HUHE32727UBHJNKJDHG276346UC37637623782BS464LLPEOOD4778348835HVAGKGHDAEGD",
            entry_type: "wasm",
            label: "balances",
            live_until_ledger: 1_000_000,  
            last_modified_ledger: 9_000_000, 
            discovery_source: "instance_scan",
        });
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "BGDFRYHD097DNND0NKKHDE1GERVCJNW4LJW5676HUHE32727UBHJNKJDHG276346UC39874109782BS464LLPEOOD4778348835HVAGKGHDAEGD",
            entry_type: "persistent",
            label: "balances",
            live_until_ledger: 1_500_000,  
            last_modified_ledger: 18_500_000, 
            discovery_source: "footprint",
        });

        const entries = getEntriesForContract(db, contractID);
        expect(entries).toHaveLength(3);

        const persistent = entries.find((e) => e.entry_type === "persistent");
        expect(persistent!.label).toBe("balances");
        expect(persistent!.discovery_source).toBe("footprint");
    });

    it("should throw error for invalid entry_type", () => {
        expect(() => {
            upsertEntry(db, {
                contract_id: contractID,
                entry_key_xdr: "INVALID_TYPE_TEST",
                entry_type: "invalid_type" as any,
            });
        }).toThrow(); // SQLite CHECK constraint
    });

    it("should handle entries with null/missing values", () => {
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "NULL_TEST",
            entry_type: "temporary",
        });
        const entries = getEntriesForContract(db, contractID);
        const entry = entries.find(e => e.entry_key_xdr === "NULL_TEST");
        expect(entry).toBeDefined();
        expect(entry!.label).toBeNull();
        expect(entry!.live_until_ledger).toBeNull();
        expect(entry!.discovery_source).toBe("deterministic");
    });

    it("cascades delete when a contract is removed", () => {
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "BGDFRYHD097DNND0NKKHDE1GERVCJN4LJW5676HUHE32727UBHJNKJDHG276346UC39874109782BS464LLPEOOD4778348835HVAGKGHDAEGD",
            entry_type: "instance",
        });
        
        upsertExtensionPolicy(db, {
            contract_id: contractID,
            target_ttl_ledgers: 1000,
            extend_when_below_ledgers: 100,
        });

        insertAlertConfig(db, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "http://test",
            threshold_ledgers: 500,
        });

        deleteContract(db, contractID);
        
        expect(getEntriesForContract(db, contractID)).toHaveLength(0);
        expect(getExtensionPolicy(db, contractID)).toBeUndefined();
        expect(getAlertConfigsForContract(db, contractID)).toHaveLength(0);
    });
});

// --------------------- Database Operations Tests For Extension Policies ---------------------

describe("Extension Policy Operations", () => {
    const contractID = "CBEK0975FU6KKOEZHGO098G6HLBS5D6LVATIGCESOGXSZEQ2UWUY8I3O";
    beforeEach(() => {
        const sampleContract = {
            id: contractID, 
            name: "sample-contract",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
            tags: "defi,pool",
        };
        insertContract(db, sampleContract)
    });

    it("inserts an extension policy into the database and retrieves it", () => {
        upsertExtensionPolicy(db, {
            contract_id: contractID,
            target_ttl_ledgers: 120000,
            extend_when_below_ledgers: 20000,
            keypair_public: "GABC...",
            keypair_source: "env:SOROKEEP_KEY",
        })
        const policy = getExtensionPolicy(db, contractID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(120000);
        expect(policy!.extend_when_below_ledgers).toBe(20000);
        expect(policy!.enabled).toBe(1);
        expect(policy!.keypair_public).toBe("GABC...");
    });
    
    it("returns undefined for a contract without policy", () => {
        const policy = getExtensionPolicy(db, "NON_EXISTENT");
        expect(policy).toBeUndefined();
    });
});

// --------------------- Database Operations Tests For Alerting ---------------------

describe("Alert Operations", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let contractAlertConfigID: number;
    let contractEntryID: number;

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
        contractEntryID = entries[0]!.id;

        insertAlertConfig(db, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://hooks.slack.com/services/...",
            threshold_ledgers: 500,
        });
        const configs = getAlertConfigsForContract(db, contractID);
        contractAlertConfigID = configs[0]!.id;
    });

    it("should insert and retrieve alert configurations", () => {
        const configs = getAlertConfigsForContract(db, contractID);
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://hooks.slack.com/services/...",
            threshold_ledgers: 500,
        });
    });

    it("should delete alert configurations", () => {
        deleteAlertConfig(db, contractAlertConfigID);
        const configs = getAlertConfigsForContract(db, contractID);
        expect(configs).toHaveLength(0);
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

        resolveAlerts(db, contractEntryID);
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
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

        resolveAlerts(db, contractEntryID);
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
        resolveAlerts(db, contractEntryID);

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
