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
    insertAlertConfig, getAlertConfigsForContract, deleteAlertConfig, hasUnresolvedAlert, recordAlertFired,
    resolveAlerts
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
        const retrievedContract = getContract(db, sampleContract.id);
        expect(retrievedContract).toBeDefined();
        expect(retrievedContract).toMatchObject({
            ...sampleContract,
            registered_at: expect.any(String),
            last_checked_ledger: null,
        });
        expect(retrievedContract!.id).toBe(sampleContract.id);
        expect(retrievedContract!.name).toBe("sample-contract");
        expect(retrievedContract!.network).toBe("testnet");
        expect(retrievedContract!.last_checked_ledger).toBeNull();
        expect(retrievedContract!.registered_at).toBeDefined();
        expect(new Date(retrievedContract!.registered_at).getTime()).toBeLessThanOrEqual(Date.now());
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

        const retrievedContract = getContract(db, sampleContract4.id);
        expect(retrievedContract!.last_checked_ledger).toBe(12345678);
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
        const retrievedContract = getContract(db, sampleContract5.id);
        expect(retrievedContract).toBeUndefined();
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
        const retrievedContract = getContract(db, sampleContract6.id);
        expect(retrievedContract).toBeDefined();
        expect(retrievedContract!.name).toBe("updated-contract-6");
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

    it("cascades delete when a contract is removed", () => {
        upsertEntry(db, {
            contract_id: contractID,
            entry_key_xdr: "BGDFRYHD097DNND0NKKHDE1GERVCJN4LJW5676HUHE32727UBHJNKJDHG276346UC39874109782BS464LLPEOOD4778348835HVAGKGHDAEGD",
            entry_type: "instance",
        });
        deleteContract(db, contractID);
        const entries = getEntriesForContract(db, contractID);
        expect(entries).toHaveLength(0);
    });
});

// --------------------- Database Operations Tests For Extension Policies ---------------------

describe("Extension Policy Operations", () => {
    // Test cases for extension policy operations
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
            keypair_source: "env:SENTINEL_KEY",
        })
        const policy = getExtensionPolicy(db, contractID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(120000);
        expect(policy!.extend_when_below_ledgers).toBe(20000);
        expect(policy!.enabled).toBe(1);
        expect(policy!.keypair_public).toBe("GABC...");
    });
    
    it("returns undefined for a contract without policy", () => {
        const retrievedPolicy = getExtensionPolicy(db, contractID);
        expect(retrievedPolicy).toBeUndefined();
    });

    it('should upsert extension policy for duplicate contract_id', () => {
        const extensionPolicy1 = {
            contract_id: contractID,
            target_ttl_ledgers: 200000,
            extend_when_below_ledgers: 30000,
        }
        const extensionPolicy2 = {
            contract_id: contractID,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 10000,
        }
        const extensionPolicy3 = {
            contract_id: contractID,
            target_ttl_ledgers: 400000,
            extend_when_below_ledgers: 50000,
        }

        upsertExtensionPolicy(db, extensionPolicy1);
        upsertExtensionPolicy(db, extensionPolicy2);
        upsertExtensionPolicy(db, extensionPolicy3);

        const retrievedPolicy = getExtensionPolicy(db, contractID);
        expect(retrievedPolicy!.target_ttl_ledgers).toBe(400000);
        expect(retrievedPolicy!.extend_when_below_ledgers).toBe(50000);
    });
});

// --------------------- Database Operations Tests For Alert Configs ---------------------

describe("Alert Config Operations", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    beforeEach(() => {
        const sampleContract = {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
        }
        insertContract(db, sampleContract)
    })

    it("should insert alert configs into the database and retrieves it", () => {
        const sampleContractAlertConfig = {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://aurl.com/alert/hook",
            threshold_ledgers: 10000,
        };
        insertAlertConfig(db, sampleContractAlertConfig);
        const retrivedContractAlertConfigs = getAlertConfigsForContract(db, contractID);
        expect(retrivedContractAlertConfigs).toHaveLength(1);
        expect(retrivedContractAlertConfigs[0]!.channel_type).toBe("webhook");
        expect(retrivedContractAlertConfigs[0]!.threshold_ledgers).toBe(10000);
    });

    it('should support multiple alert configs per for each contract', () => {
        const sampleContractAlertConfig = {
            contract_id: contractID,
            channel_type: "slack",
            channel_target: "#oncall",
            threshold_ledgers: 40000,
        };
        const sampleContractAlertConfig1 = {
            contract_id: contractID,
            channel_type: "email",
            channel_target: "username@emaildomain.com",
            threshold_ledgers: 30000,
        };

        insertAlertConfig(db, sampleContractAlertConfig);
        insertAlertConfig(db, sampleContractAlertConfig1);

        const retrievedAlertConfigs = getAlertConfigsForContract(db, contractID);
        expect(retrievedAlertConfigs).toHaveLength(2);
    });

    it('should delete an alert config by it\'s ID ', () => {
        const sampleContractAlertConfig = {
            contract_id: contractID,
            channel_type: "slack",
            channel_target: "#oncall",
            threshold_ledgers: 40000,
        };
        insertAlertConfig(db, sampleContractAlertConfig);

        const retrievedAlertConfigs = getAlertConfigsForContract(db, contractID);
        deleteAlertConfig(db, retrievedAlertConfigs[0]!.id);

        const remainingAlertConfigs = getAlertConfigsForContract(db, contractID);
        expect(remainingAlertConfigs).toHaveLength(0);
    });
})

// --------------------- Database Operations Tests For Alerts Fired and Deduplication ---------------------

describe("Alerts Fired Operations", () => {

    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let contractEntryID: number;
    let contractAlertConfigID: number;

    beforeEach(() => {
        const sampleContract = {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
            wasm_hash: "edtg728rfhnb234",
        };
        insertContract(db, sampleContract);

        const contractEntry = {
            contract_id: contractID,
            entry_key_xdr: "AAAAAgAAAADpL3ZlY3RvcgAAAAEAAAAAAAAAAQAAAAAAAAABAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAACAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAAD",
            entry_type: "instance",
            label: "balances",
            live_until_ledger: 2_500_000,
            last_modified_ledger: 11_000_000,
            discovery_source: "manual",
        }
        upsertEntry(db, contractEntry);
        const retrievedContractEntries = getEntriesForContract(db, contractID);
        contractEntryID = retrievedContractEntries[0]!.id;

        const contractAlertConfig = {
            contract_id: contractID,
            channel_type: "email",
            channel_target: "username@emaildomain.com",
            threshold_ledgers: 30000,
        }
        insertAlertConfig(db, contractAlertConfig)
        const retrievedContractAlertConfigs = getAlertConfigsForContract(db, contractID);
        contractAlertConfigID = retrievedContractAlertConfigs[0]!.id;
    });

    it('should record an alert and check for unresolved alerts', () => {
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);

        const sampleAlertFired = {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 1990000,
            ttl_at_fire: 10000,
        };
        recordAlertFired(db, sampleAlertFired);

        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(true);
    });

    it('should resolve all alerts for an entry', () => {
        const sampleAlertFired = {
            alert_config_id: contractAlertConfigID,
            contract_entry_id: contractEntryID,
            fired_at_ledger: 1920500,
            ttl_at_fire: 64000,
        };
        recordAlertFired(db, sampleAlertFired);

        resolveAlerts(db, contractEntryID);
        expect(hasUnresolvedAlert(db, contractAlertConfigID, contractEntryID)).toBe(false);
    });
});

// --------------------- Database Operations Tests For Extension History ---------------------
describe("Extension History Operations", () => {})
