import { describe, it, expect } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database";
import { exportDatabase, importDatabase } from "../../src/db/backup";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    insertAlertConfig,
    getAllContracts,
    getEntriesForContract,
    getExtensionPolicy,
    getAlertConfigsForContract,
    recordExtension,
} from "../../src/db/repositories";

describe("database backup", () => {
    it("exports restorable tables and excludes histories", () => {
        const sourceDb = getDatabaseForTesting();
        insertContract(sourceDb, { id: "C1", name: "Alpha", network: "testnet" });
        upsertEntry(sourceDb, {
            contract_id: "C1",
            entry_key_xdr: "entry-1",
            entry_type: "instance",
            live_until_ledger: 100,
            last_modified_ledger: 90,
        });
        const entryId = getEntriesForContract(sourceDb, "C1")[0].id;
        upsertExtensionPolicy(sourceDb, {
            contract_id: "C1",
            enabled: true,
            target_ttl_ledgers: 5000,
            extend_when_below_ledgers: 1000,
            keypair_public: "GABC",
            keypair_source: "env:MASTER_KEY",
        });
        insertAlertConfig(sourceDb, {
            contract_id: "C1",
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 250,
            webhook_secret: "secret",
        });
        recordExtension(sourceDb, {
            contract_id: "C1",
            contract_entry_id: entryId,
            old_ttl_ledgers: 100,
            new_ttl_ledgers: 1000,
            tx_hash: "tx-1",
            executed_at_ledger: 123,
        });

        const exported = exportDatabase(sourceDb);
        const restoredDb = getDatabaseForTesting();

        importDatabase(restoredDb, exported);

        expect(getAllContracts(restoredDb)).toHaveLength(1);
        expect(getAllContracts(restoredDb)[0]).toMatchObject({
            id: "C1",
            name: "Alpha",
            network: "testnet",
        });
        expect(getEntriesForContract(restoredDb, "C1")).toHaveLength(1);
        expect(getExtensionPolicy(restoredDb, "C1")).toMatchObject({
            target_ttl_ledgers: 5000,
            extend_when_below_ledgers: 1000,
            keypair_public: "GABC",
        });
        expect(getAlertConfigsForContract(restoredDb, "C1")).toHaveLength(1);
        expect(getAlertConfigsForContract(restoredDb, "C1")[0]).toMatchObject({
            channel_type: "webhook",
            channel_target: "https://example.com/hook",
            threshold_ledgers: 250,
            webhook_secret: "secret",
        });
        expect(exported).not.toHaveProperty("extension_history");

        sourceDb.close();
        restoredDb.close();
    });

    it("db import restores watched contracts and alert policies successfully", () => {
        const sourceDb = getDatabaseForTesting();
        insertContract(sourceDb, { id: "C1", name: "Watched", network: "testnet" });
        upsertEntry(sourceDb, {
            contract_id: "C1",
            entry_key_xdr: "instance-key",
            entry_type: "instance",
            live_until_ledger: 1200,
            last_modified_ledger: 1100,
        });
        insertAlertConfig(sourceDb, {
            contract_id: "C1",
            channel_type: "slack",
            channel_target: "#alerts",
            threshold_ledgers: 300,
        });

        const exported = exportDatabase(sourceDb);
        const restoredDb = getDatabaseForTesting();

        insertContract(restoredDb, { id: "OLD", network: "mainnet", name: "Stale" });

        importDatabase(restoredDb, exported);

        expect(getAllContracts(restoredDb)).toHaveLength(1);
        expect(getAllContracts(restoredDb)[0]).toMatchObject({
            id: "C1",
            name: "Watched",
            network: "testnet",
        });
        expect(getEntriesForContract(restoredDb, "C1")).toHaveLength(1);
        expect(getAlertConfigsForContract(restoredDb, "C1")).toHaveLength(1);
        expect(getAlertConfigsForContract(restoredDb, "C1")[0]).toMatchObject({
            channel_type: "slack",
            channel_target: "#alerts",
            threshold_ledgers: 300,
        });

        sourceDb.close();
        restoredDb.close();
    });
});
