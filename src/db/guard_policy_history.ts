import type Database from "better-sqlite3";
import { getExtensionPolicy, upsertExtensionPolicy } from "./repositories.js";

export interface GuardPolicyHistoryRecord {
    id: number;
    contract_id: string;
    enabled: boolean | number;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public?: string | null;
    keypair_source?: string | null;
    predictive_cycles?: number;
    created_at?: string;
}

/**
 * Restore an extension policy from guard_policy_history (issue #506).
 *
 * History rows are never modified or deleted. Restoring a version applies
 * it through upsertExtensionPolicy, which appends a new history row rather
 * than rewriting the one being restored from.
 */
export function rollbackExtensionPolicy(
    db: Database.Database,
    contractId: string,
    historyId?: number,
): GuardPolicyHistoryRecord {
    const current = getExtensionPolicy(db, contractId);
    if (!current) {
        throw new Error(`No extension policy configured for contract ${contractId}.`);
    }

    const rows = db.prepare(`
        SELECT
            id,
            contract_id,
            enabled,
            target_ttl_ledgers,
            extend_when_below_ledgers,
            keypair_public,
            keypair_source,
            predictive_cycles
        FROM guard_policy_history
        WHERE contract_id = ?
        ORDER BY id DESC
    `).all(contractId) as GuardPolicyHistoryRecord[];

    if (rows.length === 0) {
        throw new Error(`No policy history found for contract ${contractId}.`);
    }

    let target: GuardPolicyHistoryRecord | undefined;
    if (historyId !== undefined) {
        target = rows.find((row) => row.id === historyId);
        if (!target) {
            throw new Error(`Policy history entry ${historyId} was not found for contract ${contractId}.`);
        }
    } else {
        // rows[0] is the current (most recent) version — the previous
        // version to roll back to is the one right after it.
        target = rows[1];
        if (!target) {
            throw new Error(`No previous policy version exists for contract ${contractId}.`);
        }
    }

    upsertExtensionPolicy(db, {
        contract_id: contractId,
        enabled: Boolean(target.enabled),
        target_ttl_ledgers: target.target_ttl_ledgers,
        extend_when_below_ledgers: target.extend_when_below_ledgers,
        keypair_public: target.keypair_public ?? undefined,
        keypair_source: target.keypair_source ?? undefined,
        predictive_cycles: target.predictive_cycles ?? 0,
    });

    return target;
}

export function listPolicyHistory(db: Database.Database, contractId: string): GuardPolicyHistoryRecord[] {
    return db.prepare(`
        SELECT
            id,
            contract_id,
            enabled,
            target_ttl_ledgers,
            extend_when_below_ledgers,
            keypair_public,
            keypair_source,
            predictive_cycles,
            created_at
        FROM guard_policy_history
        WHERE contract_id = ?
        ORDER BY id DESC
    `).all(contractId) as GuardPolicyHistoryRecord[];
}
