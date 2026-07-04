import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
    insertStateSnapshot,
    getLatestSnapshot,
    insertStateChange,
} from "../db/repositories.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "StateDiff" });

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StateDiffResult {
    /** The kind of change: first appearance, value mutation, or removal. */
    diffType: "created" | "updated" | "deleted";
    /** The previous XDR value (null for `created`). */
    oldValueXdr: string | null;
    /** The current XDR value (null for `deleted`). */
    newValueXdr: string | null;
    /** SHA-256 hex hash of the old value (null for `created`). */
    oldHash: string | null;
    /** SHA-256 hex hash of the new value (null for `deleted`). */
    newHash: string | null;
}

// ─── Hash computation ─────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a raw XDR value string.
 * Used to quickly compare storage values without storing/diffing full payloads
 * every cycle.
 */
export function computeValueHash(valueXdr: string): string {
    return createHash("sha256").update(valueXdr).digest("hex");
}

// ─── Diff logic ───────────────────────────────────────────────────────────────

/**
 * Compare two XDR value strings and produce a structured diff result.
 *
 * Returns `null` when the values are identical (including both-null),
 * meaning no state change occurred.
 *
 * @param oldXdr - The previous XDR value, or null if the entry didn't exist.
 * @param newXdr - The current XDR value, or null if the entry was removed.
 */
export function diffStateValues(
    oldXdr: string | null,
    newXdr: string | null,
): StateDiffResult | null {
    // Both null → no change
    if (oldXdr === null && newXdr === null) return null;

    // Both present and identical → no change
    if (oldXdr !== null && newXdr !== null && oldXdr === newXdr) return null;

    // Created: entry didn't exist before
    if (oldXdr === null && newXdr !== null) {
        return {
            diffType: "created",
            oldValueXdr: null,
            newValueXdr: newXdr,
            oldHash: null,
            newHash: computeValueHash(newXdr),
        };
    }

    // Deleted: entry existed before but is now gone
    if (oldXdr !== null && newXdr === null) {
        return {
            diffType: "deleted",
            oldValueXdr: oldXdr,
            newValueXdr: null,
            oldHash: computeValueHash(oldXdr),
            newHash: null,
        };
    }

    // Updated: both present and different
    return {
        diffType: "updated",
        oldValueXdr: oldXdr!,
        newValueXdr: newXdr!,
        oldHash: computeValueHash(oldXdr!),
        newHash: computeValueHash(newXdr!),
    };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Process a state diff for a single contract entry within a monitoring cycle.
 *
 * 1. Fetch the latest snapshot for this entry from the DB.
 * 2. Compare the current value hash against the stored hash.
 * 3. If changed → persist a new snapshot and a state_change record.
 * 4. If unchanged → return null (storage-optimised: no writes).
 *
 * @param db              - An open better-sqlite3 Database handle.
 * @param contractEntryId - The `contract_entries.id` of the entry being checked.
 * @param currentValueXdr - The XDR-encoded value returned by the RPC for this entry.
 * @param currentLedger   - The ledger sequence at which this value was observed.
 * @returns A `StateDiffResult` describing the change, or `null` if unchanged.
 */
export function processStateDiff(
    db: Database.Database,
    contractEntryId: number,
    currentValueXdr: string,
    currentLedger: number,
): StateDiffResult | null {
    const currentHash = computeValueHash(currentValueXdr);
    const lastSnapshot = getLatestSnapshot(db, contractEntryId);

    // ── Determine diff ────────────────────────────────────────────────────────
    const oldXdr = lastSnapshot?.value_xdr ?? null;
    const diff = diffStateValues(oldXdr, currentValueXdr);

    if (diff === null) {
        // Value unchanged — skip writes to optimise storage
        logger.debug(
            `State unchanged for entry ${contractEntryId} at ledger ${currentLedger}`,
        );
        return null;
    }

    // ── Persist new snapshot ──────────────────────────────────────────────────
    const newSnapshotId = insertStateSnapshot(db, {
        contract_entry_id: contractEntryId,
        snapshot_ledger: currentLedger,
        value_hash: currentHash,
        value_xdr: currentValueXdr,
    });

    // ── Persist state change ─────────────────────────────────────────────────
    const diffJson = JSON.stringify({
        diffType: diff.diffType,
        oldValueXdr: diff.oldValueXdr,
        newValueXdr: diff.newValueXdr,
        oldHash: diff.oldHash,
        newHash: diff.newHash,
    });

    insertStateChange(db, {
        contract_entry_id: contractEntryId,
        old_snapshot_id: lastSnapshot?.id,
        new_snapshot_id: newSnapshotId,
        diff_type: diff.diffType,
        diff_json: diffJson,
        detected_at_ledger: currentLedger,
    });

    logger.info(
        `State ${diff.diffType} detected for entry ${contractEntryId} at ledger ${currentLedger}`,
    );

    return diff;
}
