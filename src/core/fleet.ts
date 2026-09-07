import type Database from "better-sqlite3";
import { getAllContracts, upsertExtensionPolicy, type Contract } from "../db/repositories.js";

export interface BulkPolicyResult {
    contractId: string;
    name: string | null;
    status: "ok" | "error";
    error?: string;
}

export interface GuardPolicyInput {
    enabled?: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public?: string;
    keypair_source?: string;
    max_fee_stroops?: number | null;
}

/**
 * Checks if a contract's tags contain the target tag.
 * Handles comma-separated tags, trimming whitespace and comparing case-insensitively.
 */
function hasTag(contract: Contract, targetTag: string): boolean {
    if (!contract.tags) return false;
    const normalizedTarget = targetTag.trim().toLowerCase();
    const tagList = contract.tags.split(",").map((t) => t.trim().toLowerCase());
    return tagList.includes(normalizedTarget);
}

/**
 * Applies a guard extension policy in bulk to all contracts matching a tag.
 * Uses batch fault-isolation: if a write for one contract fails, it is caught and recorded,
 * while processing continues for remaining contracts.
 */
export function applyGuardPolicyByTag(
    db: Database.Database,
    tag: string,
    policy: GuardPolicyInput,
): BulkPolicyResult[] {
    const contracts = getAllContracts(db);
    const matchingContracts = contracts.filter((c) => hasTag(c, tag));
    const results: BulkPolicyResult[] = [];

    for (const contract of matchingContracts) {
        try {
            upsertExtensionPolicy(db, {
                contract_id: contract.id,
                enabled: policy.enabled,
                target_ttl_ledgers: policy.target_ttl_ledgers,
                extend_when_below_ledgers: policy.extend_when_below_ledgers,
                keypair_public: policy.keypair_public,
                keypair_source: policy.keypair_source,
                max_fee_stroops: policy.max_fee_stroops ?? null,
            });
            results.push({
                contractId: contract.id,
                name: contract.name,
                status: "ok",
            });
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            results.push({
                contractId: contract.id,
                name: contract.name,
                status: "error",
                error: errorMsg,
            });
        }
    }

    return results;
}
