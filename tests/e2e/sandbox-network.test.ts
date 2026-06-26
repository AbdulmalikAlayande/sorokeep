import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { watchContract } from "../../src/core/watch.js";
import { runMonitorCycle } from "../../src/core/monitor.js";
import { runAutoExtensions } from "../../src/core/extension.js";
import {
    getAlertHistory,
    getEntriesForContract,
    getExtensionHistory,
    insertAlertConfig,
    upsertExtensionPolicy,
} from "../../src/db/repositories.js";
import { fundedSandboxKeypair, InMemorySorobanSandbox } from "./helpers/in-memory-soroban-sandbox.js";

describe("E2E sandbox network TTL lifecycle", () => {
    let db: Database.Database;
    let sandbox: InMemorySorobanSandbox;

    beforeEach(async () => {
        db = getDatabaseForTesting();
        sandbox = await InMemorySorobanSandbox.start({ initialLedger: 10_000 });
    });

    afterEach(async () => {
        await sandbox.stop();
        db.close();
    });

    it("bootstraps a local sandbox, deploys a test contract, watches it, auto-extends low TTL entries, and verifies recovery", async () => {
        const deployment = sandbox.deployTestContract({ ttlLedgers: 6 });
        const maintenanceKeypair = fundedSandboxKeypair();

        const watchResult = await watchContract(db, {
            contractId: deployment.contractId,
            network: "sandbox",
            name: "E2E Test Contract",
            rpcUrl: sandbox.rpcUrl,
        });

        expect(watchResult.success).toBe(true);
        expect(getEntriesForContract(db, deployment.contractId).map((entry) => entry.entry_type).sort())
            .toEqual(["instance", "wasm"]);

        insertAlertConfig(db, {
            contract_id: deployment.contractId,
            channel_type: "webhook",
            channel_target: "http://127.0.0.1:9/e2e-alert-sink",
            threshold_ledgers: 5,
            webhook_secret: "e2e-secret",
        });
        upsertExtensionPolicy(db, {
            contract_id: deployment.contractId,
            enabled: true,
            target_ttl_ledgers: 50,
            extend_when_below_ledgers: 5,
            keypair_public: maintenanceKeypair.publicKey(),
            keypair_source: maintenanceKeypair.secret(),
        });

        sandbox.advanceLedgers(3);
        expect(sandbox.remainingTtl(deployment.instanceKeyXdr)).toBe(3);

        const lowTtlCycle = await runMonitorCycle(db, "sandbox", sandbox.rpcUrl);
        expect(lowTtlCycle.errors).toEqual([]);
        expect(lowTtlCycle.contractsChecked).toBe(1);
        expect(lowTtlCycle.entriesUpdated).toBe(2);
        expect(lowTtlCycle.thresholdsCrossed).toBeGreaterThanOrEqual(1);

        const autoExtension = await runAutoExtensions(db, "sandbox", sandbox.rpcUrl);
        expect(autoExtension.errors).toEqual([]);
        expect(autoExtension.contractsChecked).toBe(1);
        expect(autoExtension.contractsExtended).toBe(1);
        expect(autoExtension.entriesExtended).toBeGreaterThanOrEqual(1);

        const postExtensionCycle = await runMonitorCycle(db, "sandbox", sandbox.rpcUrl);
        expect(postExtensionCycle.errors).toEqual([]);
        expect(postExtensionCycle.alertsResolved).toBeGreaterThanOrEqual(1);

        const entries = getEntriesForContract(db, deployment.contractId);
        for (const entry of entries) {
            expect(entry.live_until_ledger - sandbox.latestLedger).toBeGreaterThanOrEqual(45);
        }

        const history = getExtensionHistory(db, deployment.contractId);
        expect(history).toHaveLength(2);
        expect(history.every((record) => record.new_ttl_ledgers >= 45)).toBe(true);

        const alerts = getAlertHistory(db, deployment.contractId);
        expect(alerts.length).toBeGreaterThanOrEqual(1);
        expect(alerts.every((alert) => alert.resolved === 1)).toBe(true);
    });
});