import type Database from "better-sqlite3";
import { StellarRpcClient } from "../rpc/client.js";
import {
    getAllContracts,
    getContract,
    getEntriesForContract,
    getExtensionPolicy,
    getChannelAccounts,
    recordExtension,
    upsertEntry,
    updateLastCheckedLedger,
    getAverageResourceUsage,
} from "../db/repositories.js";
import { ChannelAccountPool } from "./channels.js";
import { getLogger } from "../logging/index.js";
import { VaultResolver } from "./vault.js";
import { loadConfig } from "../utils/config.js";

const logger = getLogger().child({ component: "Extension" });

// ─── Public contract ──────────────────────────────────────────────────────────

export interface ExtensionResult {
    /** Whether the extension was successful. */
    success: boolean;
    /** Contract ID that was extended. */
    contractId: string;
    /** Number of entries that were extended. */
    entriesExtended: number;
    /** Transaction hash if submitted. */
    txHash?: string;
    /** New ledger number after extension. */
    ledger?: number;
    /** Error message if failed. */
    error?: string;
    /** Estimated fee in stroops (from simulation, before submission). */
    estimatedFee?: number;
    /** Actual fee charged in stroops (from submitted transaction result). */
    feeCharged?: number;
    /** CPU instructions consumed by the transaction. */
    cpuInsns?: number;
    /** Memory bytes consumed by the transaction. */
    memBytes?: number;
    /** Whether resource usage spiked. */
    isAnomaly?: boolean;
    /** Details about the anomaly if present. */
    anomalyDetails?: string;
}

export interface AutoExtensionResult {
    /** Total contracts checked for auto-extension. */
    contractsChecked: number;
    /** Number of contracts where entries were actually extended. */
    contractsExtended: number;
    /** Total entries extended across all contracts. */
    entriesExtended: number;
    /** Per-contract errors (non-fatal). */
    errors: string[];
    /** Details of each successful extension. */
    extensions: Array<{
        contractId: string;
        txHash: string;
        entriesExtended: number;
        ledger: number;
        isAnomaly?: boolean;
        anomalyDetails?: string;
    }>;
}

export interface RestoreResult {
    /** Whether the restore was successful. */
    success: boolean;
    /** Contract ID. */
    contractId: string;
    /** Number of entries restored. */
    entriesRestored: number;
    /** Transaction hash if submitted. */
    txHash?: string;
    /** Ledger number. */
    ledger?: number;
    /** Error message if failed. */
    error?: string;
}

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * Simulate a TTL extension for specific entries of a contract.
 * Does NOT submit — only estimates fees. Useful for dry-run / cost preview.
 */
export async function simulateExtension(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    extendToLedgers: number,
    sourcePublicKey: string,
    rpcUrl?: string,
): Promise<ExtensionResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesExtended: 0, error: "Contract not found" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    const sim = await client.simulateExtension(entryKeyXdrs, extendToLedgers, sourcePublicKey);

    if (!sim.success) {
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            error: sim.error,
        };
    }

    return {
        success: true,
        contractId,
        entriesExtended: entryKeyXdrs.length,
        estimatedFee: sim.minResourceFee,
    };
}

/**
 * Extend TTL for specific entries of a contract.
 * Builds, simulates, signs, and submits an ExtendFootprintTTLOp transaction.
 */
export async function extendEntries(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    extendToLedgers: number,
    secretKey: string,
    rpcUrl?: string,
): Promise<ExtensionResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesExtended: 0, error: "Contract not found" };
    }

    if (entryKeyXdrs.length === 0) {
        return { success: false, contractId, entriesExtended: 0, error: "No entries to extend" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    logger.info(
        `Extending ${entryKeyXdrs.length} entries for ${contractId} to ${extendToLedgers} ledgers`,
    );

    const txResult = await client.submitExtension(entryKeyXdrs, extendToLedgers, secretKey);

    if (!txResult.success) {
        logger.error(`Extension failed for ${contractId}: ${txResult.error}`);
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            txHash: txResult.txHash || undefined,
            error: txResult.error,
        };
    }

    let isAnomaly = false;
    let anomalyDetails: string | undefined = undefined;

    if (txResult.cpuInsns && txResult.memBytes) {
        const baseline = getAverageResourceUsage(db, contractId, 10);
        if (baseline && baseline.avg_cpu_insns > 0 && baseline.avg_mem_bytes > 0) {
            const cpuRatio = txResult.cpuInsns / baseline.avg_cpu_insns;
            const memRatio = txResult.memBytes / baseline.avg_mem_bytes;
            if (cpuRatio >= 2.0 || memRatio >= 2.0) {
                isAnomaly = true;
                const details = [];
                if (cpuRatio >= 2.0) details.push(`CPU usage is ${cpuRatio.toFixed(2)}x baseline`);
                if (memRatio >= 2.0) details.push(`Memory usage is ${memRatio.toFixed(2)}x baseline`);
                anomalyDetails = `Resource anomaly detected: ` + details.join(", ");
            }
        }
    }

    // Fetch fresh TTLs after extension to update DB and record history
    const freshTTLs = await client.getEntryTTLs(entryKeyXdrs);
    const entries = getEntriesForContract(db, contractId);
    const entryMap = new Map(entries.map(e => [e.entry_key_xdr, e]));

    // Wrap all DB updates in a transaction for atomicity
    const updateDb = db.transaction(() => {
        for (const freshEntry of freshTTLs.entries) {
            const dbEntry = entryMap.get(freshEntry.entryKeyXdr);
            if (!dbEntry) continue;

            const oldTTL = dbEntry.live_until_ledger
                ? dbEntry.live_until_ledger - freshTTLs.latestLedger
                : 0;

            // Record the extension in history
            recordExtension(db, {
                contract_id: contractId,
                contract_entry_id: dbEntry.id,
                old_ttl_ledgers: Math.max(0, oldTTL),
                new_ttl_ledgers: freshEntry.remainingTTL,
                tx_hash: txResult.txHash,
                cpu_insns: txResult.cpuInsns,
                mem_bytes: txResult.memBytes,
                is_anomaly: isAnomaly,
                executed_at_ledger: freshTTLs.latestLedger,
            });

            // Update the entry with fresh TTL
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: freshEntry.entryKeyXdr,
                entry_type: dbEntry.entry_type,
                label: dbEntry.label ?? undefined,
                live_until_ledger: freshEntry.liveUntilLedgerSeq,
                last_modified_ledger: freshEntry.lastModifiedLedgerSeq,
                discovery_source: dbEntry.discovery_source,
            });
        }

        updateLastCheckedLedger(db, contractId, freshTTLs.latestLedger);
    });
    updateDb();

    logger.info(
        `Extension successful for ${contractId}: tx=${txResult.txHash}, entries=${entryKeyXdrs.length}`,
    );

    return {
        success: true,
        contractId,
        entriesExtended: entryKeyXdrs.length,
        txHash: txResult.txHash,
        ledger: txResult.ledger,
        feeCharged: txResult.feeCharged,
        cpuInsns: txResult.cpuInsns,
        memBytes: txResult.memBytes,
        isAnomaly,
        anomalyDetails,
    };
}

/**
 * Run auto-extension for all contracts with enabled extension policies.
 * Called by the daemon after each monitor cycle.
 *
 * For each contract with an enabled policy, checks if any entries have
 * a remaining TTL below `extend_when_below_ledgers`. If so, extends them
 * to `target_ttl_ledgers`.
 *
 * Errors for individual contracts are collected, not thrown.
 */
export async function runAutoExtensions(
    db: Database.Database,
    network: string,
    rpcUrl?: string,
): Promise<AutoExtensionResult> {
    const result: AutoExtensionResult = {
        contractsChecked: 0,
        contractsExtended: 0,
        entriesExtended: 0,
        errors: [],
        extensions: [],
    };

    const contracts = getAllContracts(db).filter(c => c.network === network);

    const eligibleContracts = contracts.filter(c => {
        const p = getExtensionPolicy(db, c.id);
        return p && p.enabled;
    });

    if (eligibleContracts.length === 0) return result;

    const client = new StellarRpcClient(network, rpcUrl);
    const latestLedger = await client.getCurrentLedger();

    // Build pool from registered channel accounts; fall back to per-policy keypairs
    const channelAccounts = getChannelAccounts(db, network);
    const pool = channelAccounts.length > 0
        ? new ChannelAccountPool(db, network)
        : null;

    result.contractsChecked = eligibleContracts.length;

    // Process all eligible contracts concurrently, one channel account slot per task.
    await Promise.all(eligibleContracts.map(async contract => {
        const policy = getExtensionPolicy(db, contract.id)!;

        try {
            const entries = getEntriesForContract(db, contract.id);

            const needsExtension = entries.filter(e => {
                if (!e.live_until_ledger) return false;
                const remaining = e.live_until_ledger - latestLedger;
                return remaining > 0 && remaining < policy.extend_when_below_ledgers;
            });

            if (needsExtension.length === 0) return;

            // Resolve secret key: prefer channel pool, fall back to policy keypair
            let secretKey: string | null = null;
            let slot: import("./channels.js").ChannelSlot | null = null;

            if (pool) {
                slot = await pool.acquire();
                secretKey = await resolveSecretKey(slot.keypairSource);
                if (!secretKey) {
                    pool.release(slot.publicKey);
                    slot = null;
                }
            }

            if (!secretKey) {
                secretKey = await resolveSecretKey(policy.keypair_source);
            }

            if (!secretKey) {
                result.errors.push(
                    `Contract ${contract.id}: Cannot resolve keypair from source "${pool ? "channel pool" : policy.keypair_source}"`,
                );
                return;
            }

            const entryKeys = needsExtension.map(e => e.entry_key_xdr);

            logger.info(
                `Auto-extending ${entryKeys.length} entries for ${contract.id} ` +
                `(below ${policy.extend_when_below_ledgers}, target ${policy.target_ttl_ledgers})`,
            );

            try {
                const extResult = await extendEntries(
                    db,
                    contract.id,
                    entryKeys,
                    policy.target_ttl_ledgers,
                    secretKey,
                    rpcUrl,
                );

                if (extResult.success) {
                    result.contractsExtended++;
                    result.entriesExtended += extResult.entriesExtended;
                    result.extensions.push({
                        contractId: contract.id,
                        txHash: extResult.txHash!,
                        entriesExtended: extResult.entriesExtended,
                        ledger: extResult.ledger!,
                        isAnomaly: extResult.isAnomaly,
                        anomalyDetails: extResult.anomalyDetails,
                    });
                } else {
                    result.errors.push(
                        `Contract ${contract.id}: Extension failed — ${extResult.error}`,
                    );
                }
            } finally {
                if (slot && pool) pool.release(slot.publicKey);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result.errors.push(`Contract ${contract.id}: ${message}`);
            logger.error(`Auto-extension error for ${contract.id}: ${message}`, err);
        }
    }));

    return result;
}

/**
 * Restore archived entries for a contract.
 * Submits a RestoreFootprintOp transaction.
 */
export async function restoreEntries(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    secretKey: string,
    rpcUrl?: string,
): Promise<RestoreResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesRestored: 0, error: "Contract not found" };
    }

    if (entryKeyXdrs.length === 0) {
        return { success: false, contractId, entriesRestored: 0, error: "No entries to restore" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    logger.info(`Restoring ${entryKeyXdrs.length} entries for ${contractId}`);

    const txResult = await client.submitRestore(entryKeyXdrs, secretKey);

    if (!txResult.success) {
        logger.error(`Restore failed for ${contractId}: ${txResult.error}`);
        return {
            success: false,
            contractId,
            entriesRestored: 0,
            txHash: txResult.txHash || undefined,
            error: txResult.error,
        };
    }

    // Refresh TTLs after restore
    const freshTTLs = await client.getEntryTTLs(entryKeyXdrs);
    const entries = getEntriesForContract(db, contractId);
    const entryMap = new Map(entries.map(e => [e.entry_key_xdr, e]));

    let restored = 0;

    // Wrap all DB updates in a transaction for atomicity
    const updateDb = db.transaction(() => {
        for (const freshEntry of freshTTLs.entries) {
            const dbEntry = entryMap.get(freshEntry.entryKeyXdr);
            if (!dbEntry) continue;

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: freshEntry.entryKeyXdr,
                entry_type: dbEntry.entry_type,
                label: dbEntry.label ?? undefined,
                live_until_ledger: freshEntry.liveUntilLedgerSeq,
                last_modified_ledger: freshEntry.lastModifiedLedgerSeq,
                discovery_source: dbEntry.discovery_source,
            });
            restored++;
        }

        updateLastCheckedLedger(db, contractId, freshTTLs.latestLedger);
    });
    updateDb();

    logger.info(`Restore successful for ${contractId}: tx=${txResult.txHash}, entries=${restored}`);

    return {
        success: true,
        contractId,
        entriesRestored: restored,
        txHash: txResult.txHash,
        ledger: txResult.ledger,
    };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a secret key from a keypair_source string.
 * Supports:
 *   - "env:VAR_NAME" — reads from environment variable
 *   - "vault:<secret_path>" — reads from HashiCorp Vault (KV v1/v2)
 *   - Direct secret key string starting with "S" (56 chars)
 */
export async function resolveSecretKey(source: string | null): Promise<string | null> {
    if (!source) return null;

    if (source.startsWith("env:")) {
        const envVar = source.slice(4);
        const value = process.env[envVar];
        if (!value) {
            logger.warn(`Environment variable ${envVar} not set`);
            return null;
        }
        return value;
    }

    if (source.startsWith("vault:")) {
        const vaultPath = source.slice(6);
        if (!vaultPath) {
            logger.warn("Vault keypair_source is empty");
            return null;
        }

        try {
            const config = loadConfig();
            if (!config.vault?.url || !config.vault?.token) {
                logger.error("Vault resolver requested but vault configuration missing in config.yaml (vault.url / vault.token)");
                return null;
            }

            const resolver = new VaultResolver({
                url: config.vault.url,
                token: config.vault.token,
                namespace: config.vault.namespace,
            });

            const secret = await resolver.getSecret(vaultPath);
            return secret;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to resolve secret from Vault path "${vaultPath}": ${message}`);
            return null;
        }
    }

    // Direct secret key
    if (source.startsWith("S") && source.length === 56) {
        return source;
    }

    logger.warn(`Unknown keypair_source format: ${source}`);
    return null;
}
