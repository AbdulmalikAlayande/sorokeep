import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertExtensionPolicy } from "../../src/db/repositories.js";
import { rollbackExtensionPolicy, listPolicyHistory } from "../../src/db/guard_policy_history.js";

describe("Guard policy history & rollback (#506)", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        insertContract(db, { id: "C1", network: "testnet" });
    });

    afterEach(() => {
        db.close();
    });

    it("records a history row every time the policy is upserted", () => {
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 10000, extend_when_below_ledgers: 5000 });
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 20000, extend_when_below_ledgers: 8000 });

        const history = listPolicyHistory(db, "C1");
        expect(history.length).toBe(2);
        expect(history[0].target_ttl_ledgers).toBe(20000);
        expect(history[1].target_ttl_ledgers).toBe(10000);
    });

    it("rolls back to the immediately previous version when --to is omitted", () => {
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 10000, extend_when_below_ledgers: 5000 });
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 20000, extend_when_below_ledgers: 8000 });

        const restored = rollbackExtensionPolicy(db, "C1");
        expect(restored.target_ttl_ledgers).toBe(10000);

        // Restoring appends a new history row rather than rewriting the old one.
        const history = listPolicyHistory(db, "C1");
        expect(history.length).toBe(3);
        expect(history[0].target_ttl_ledgers).toBe(10000);
    });

    it("rolls back to a specific history ID", () => {
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 10000, extend_when_below_ledgers: 5000 });
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 20000, extend_when_below_ledgers: 8000 });
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 30000, extend_when_below_ledgers: 9000 });

        const firstVersionId = listPolicyHistory(db, "C1").at(-1)!.id;
        const restored = rollbackExtensionPolicy(db, "C1", firstVersionId);
        expect(restored.target_ttl_ledgers).toBe(10000);
    });

    it("throws when no policy exists for the contract", () => {
        expect(() => rollbackExtensionPolicy(db, "C1")).toThrow(/no extension policy/i);
    });

    it("throws when only one version exists and no --to is given", () => {
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 10000, extend_when_below_ledgers: 5000 });
        expect(() => rollbackExtensionPolicy(db, "C1")).toThrow(/no previous policy version/i);
    });

    it("throws when the given history ID does not belong to the contract", () => {
        upsertExtensionPolicy(db, { contract_id: "C1", enabled: true, target_ttl_ledgers: 10000, extend_when_below_ledgers: 5000 });
        expect(() => rollbackExtensionPolicy(db, "C1", 9999)).toThrow(/was not found/i);
    });
});
