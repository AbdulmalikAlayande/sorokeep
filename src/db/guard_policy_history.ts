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
}

/**
 * Restore an extension policy from guard_policy_history.
 *
 * The selected history row is never modified. Applying the restored values
 * through upsertExtensionPolicy creates a new policy/history version.
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
            keypair_source
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
    });

    return target;
}
