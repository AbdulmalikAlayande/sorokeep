/**
 * TDD tests for guard_policy_history repository functions.
 *
 * Acceptance criteria:
 *   1. Every policy update produces exactly one history row capturing the prior values.
 *   2. getGuardPolicyHistory returns rows in chronological order (oldest first) for a given contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertExtensionPolicy,
    getGuardPolicyHistory,
    type GuardPolicyHistoryRecord,
} from "../../src/db/repositories.js";

const CONTRACT_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_B = "CBIELTK6YBZJU5UP2WWQEQPMKQZKD5LTDCL3OLHQMBCILHVFVVLJUIJF";

describe("Guard Policy History – repository layer", () => {
    let db: ReturnType<typeof getDatabaseForTesting>;

    beforeEach(() => {
        db = getDatabaseForTesting();
        insertContract(db, { id: CONTRACT_A, network: "testnet", name: "Contract A" });
        insertContract(db, { id: CONTRACT_B, network: "testnet", name: "Contract B" });
    });

    afterEach(() => {
        db.close();
    });

    // ── Criterion 1: every upsert produces exactly one history row ─────────────

    it("records one history row on the first insert (no prior values — old values are NULL)", () => {
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(1);

        const row = history[0]!;
        expect(row.contract_id).toBe(CONTRACT_A);
        // First insert: no prior row exists, so old_* values must be NULL
        expect(row.old_enabled).toBeNull();
        expect(row.old_target_ttl_ledgers).toBeNull();
        expect(row.old_extend_when_below_ledgers).toBeNull();
        expect(row.old_keypair_public).toBeNull();
        expect(row.old_keypair_source).toBeNull();
        // New values are captured
        expect(row.new_enabled).toBe(1);
        expect(row.new_target_ttl_ledgers).toBe(100_000);
        expect(row.new_extend_when_below_ledgers).toBe(20_000);
    });

    it("records a second history row (with prior values) on a subsequent update", () => {
        // First upsert — establishes baseline
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        // Second upsert — changes target TTL and threshold
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 200_000,
            extend_when_below_ledgers: 40_000,
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(2);

        const second = history[1]!; // chronological order → index 1 is the newer row
        expect(second.old_enabled).toBe(1);
        expect(second.old_target_ttl_ledgers).toBe(100_000);
        expect(second.old_extend_when_below_ledgers).toBe(20_000);
        expect(second.new_target_ttl_ledgers).toBe(200_000);
        expect(second.new_extend_when_below_ledgers).toBe(40_000);
    });

    it("records exactly one row per upsert call — not zero, not two", () => {
        for (let i = 1; i <= 5; i++) {
            upsertExtensionPolicy(db, {
                contract_id: CONTRACT_A,
                enabled: i % 2 === 0,
                target_ttl_ledgers: i * 10_000,
                extend_when_below_ledgers: i * 2_000,
            });
        }

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(5);
    });

    it("captures keypair_public and keypair_source in both old and new values", () => {
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
            keypair_public: "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU",
            keypair_source: "env:OLD_KEY",
        });

        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
            keypair_public: "GBTJXYZABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
            keypair_source: "env:NEW_KEY",
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(2);

        const second = history[1]!;
        expect(second.old_keypair_public).toBe("GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU");
        expect(second.old_keypair_source).toBe("env:OLD_KEY");
        expect(second.new_keypair_public).toBe("GBTJXYZABCDEF1234567890ABCDEF1234567890ABCDEF1234567890");
        expect(second.new_keypair_source).toBe("env:NEW_KEY");
    });

    it("records the correct old enabled=false → new enabled=true transition", () => {
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: false,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(2);

        const second = history[1]!;
        expect(second.old_enabled).toBe(0);
        expect(second.new_enabled).toBe(1);
    });

    // ── Criterion 2: results are in chronological order ───────────────────────

    it("returns rows in chronological order (oldest first)", () => {
        // Insert three changes one after another
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 50_000,
            extend_when_below_ledgers: 5_000,
        });

        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 10_000,
        });

        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: false,
            target_ttl_ledgers: 150_000,
            extend_when_below_ledgers: 15_000,
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(3);

        // Each successive row should have a changed_at >= the previous
        for (let i = 1; i < history.length; i++) {
            expect(history[i]!.changed_at >= history[i - 1]!.changed_at).toBe(true);
        }

        // The new values follow the insertion order
        expect(history[0]!.new_target_ttl_ledgers).toBe(50_000);
        expect(history[1]!.new_target_ttl_ledgers).toBe(100_000);
        expect(history[2]!.new_target_ttl_ledgers).toBe(150_000);
    });

    it("returns an empty array when no policy has ever been set for the contract", () => {
        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(0);
        expect(Array.isArray(history)).toBe(true);
    });

    it("isolates history between contracts — contract B's changes don't appear in contract A's history", () => {
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_B,
            enabled: true,
            target_ttl_ledgers: 200_000,
            extend_when_below_ledgers: 30_000,
        });

        const historyA = getGuardPolicyHistory(db, CONTRACT_A);
        const historyB = getGuardPolicyHistory(db, CONTRACT_B);

        expect(historyA).toHaveLength(1);
        expect(historyB).toHaveLength(1);

        expect(historyA[0]!.new_target_ttl_ledgers).toBe(100_000);
        expect(historyB[0]!.new_target_ttl_ledgers).toBe(200_000);
    });

    it("history row has a changed_at timestamp", () => {
        upsertExtensionPolicy(db, {
            contract_id: CONTRACT_A,
            enabled: true,
            target_ttl_ledgers: 100_000,
            extend_when_below_ledgers: 20_000,
        });

        const history = getGuardPolicyHistory(db, CONTRACT_A);
        expect(history).toHaveLength(1);
        expect(typeof history[0]!.changed_at).toBe("string");
        expect(history[0]!.changed_at.length).toBeGreaterThan(0);
    });
});
