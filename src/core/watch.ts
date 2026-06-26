import type Database from "better-sqlite3";
import { StellarRpcClient, ContractInstanceResult, SorokeepLedgerEntryResult } from "../rpc/client.js";
import {
    insertContract,
    upsertEntry,
    updateLastCheckedLedger,
    getContract,
    updateLastIntrospectedAt,
    isIntrospectionCacheValid,
} from "../db/repositories.js";
import {getLogger} from "../logging/index.js";

const logger = getLogger()

export interface WatchOptions {
    contractId: string;
    network: string;
    name?: string;
    rpcUrl?: string;
    storageKeys?: string[];
    /**
     * When true, skip the introspection cache and always fetch fresh data from
     * the RPC. Useful for manual `watch` commands where the user expects an
     * immediate refresh.  Defaults to false.
     */
    forceRefresh?: boolean;
    noIntrospection?: boolean;
}

export type WatchResult =
    | {
    success: true;
    contractId: string;
    instance: ContractInstanceResult;
    wasm: SorokeepLedgerEntryResult | null;
    wasmWarning?: string;
    /** True when the result was served from the introspection cache (no RPC call). */
    fromCache?: boolean;
} | {
    success: false;
    contractId: string;
    error: string;
};

/**
 * Core logic to discover and register a contract and its key entries.
 * - This is `Layer 1` of the architecture.
 */
export async function watchContract(db: Database.Database, options: WatchOptions): Promise<WatchResult> {
    logger.debug(`Watching contract ${options.contractId} on ${options.network}`);
    const { contractId, network, name, rpcUrl, storageKeys, forceRefresh = false } = options;

    // Basic Validation
    if (!contractId.startsWith("C") || contractId.length !== 56) {
        logger.error(`Invalid Contract ID format: ${contractId}`);
        return {
            success: false,
            contractId,
            error: "Invalid Contract ID format. Must be a 56-character string starting with 'C'.",
        };
    }

    const client = new StellarRpcClient(network, rpcUrl);

    try {
        // 0. Check if already registered on a different network
        const existing = getContract(db, contractId);
        if (existing && existing.network !== network) {
            logger.warn(`Contract ${contractId} is already registered on ${existing.network}. To watch on ${network}, unwatch it first.`);
            return {
                success: false,
                contractId,
                error: `Contract ${contractId} is already registered on ${existing.network}. To watch on ${network}, unwatch it first.`,
            };
        }

        // ── Introspection cache check ─────────────────────────────────────────
        // If the contract has been introspected recently (within 24 h) and the
        // caller did not request a forced refresh, skip the RPC calls entirely
        // and return the cached result.
        if (!forceRefresh && isIntrospectionCacheValid(db, contractId)) {
            logger.debug(`Contract ${contractId}: introspection cache is valid — skipping RPC calls`);

            // Build a minimal success result from cached DB data.
            // We return success=true without real instance/wasm objects so that
            // callers (CLI, daemon) know the operation succeeded. The actual
            // entry data remains accurate in the DB from the last introspection.
            return {
                success: true,
                contractId,
                // Provide stub values — callers that need live RPC data should
                // use forceRefresh=true.
                instance: {
                    entryKeyXdr: "",
                    latestLedger: 0,
                    liveUntilLedgerSeq: 0,
                    lastModifiedLedgerSeq: 0,
                    remainingTTL: 0,
                    executableType: "cached",
                    wasmHash: existing?.wasm_hash ?? null,
                },
                wasm: null,
                fromCache: true,
            };
        }

        // 1. Fetch Contract Instance Entry
        const instanceEntry = await client.getContractInstanceEntry(contractId);
        if (!instanceEntry) {
            return {
                success: false,
                contractId,
                error: `Contract ${contractId} not found on ${network}.`,
            };
        }

        // 2. Fetch WASM code entry if applicable
        let wasmEntry: SorokeepLedgerEntryResult | null = null;
        let wasmWarning: string | undefined;

        if (instanceEntry.wasmHash && !options.noIntrospection) {
            wasmEntry = await client.getWasmCodeEntry(instanceEntry.wasmHash);
            if (!wasmEntry) {
                wasmWarning = `WASM entry for hash ${instanceEntry.wasmHash} not found. It might be archived.`;
            }
        }

        // 3. Fetch Manual Storage Keys if provided
        const extraEntries: SorokeepLedgerEntryResult[] = [];
        if (storageKeys && storageKeys.length > 0) {
            const ttls = await client.getEntryTTLs(storageKeys);
            extraEntries.push(...ttls.entries);
        }

        // 3.5. Introspection: Fetch monitored keys if contract supports it
        const introspectedEntries: SorokeepLedgerEntryResult[] = [];
        if (!options.noIntrospection) {
            try {
                const keys = await client.getMonitoredKeys(contractId);
                if (keys.length > 0) {
                    const ttls = await client.getEntryTTLs(keys);
                    introspectedEntries.push(...ttls.entries);
                }
            } catch (error) {
                logger.debug(`Introspection skipped for ${contractId}: ${error}`);
            }
        }

        // 4. Store in Database
        // Note: insertContract uses ON CONFLICT(id) DO UPDATE
        insertContract(db, {
            id: contractId,
            name: name,
            network: network,
            wasm_hash: instanceEntry.wasmHash ?? undefined,
        });

        // Store Instance Entry
        upsertEntry(db, {
            contract_id: contractId,
            entry_key_xdr: instanceEntry.entryKeyXdr,
            entry_type: "instance",
            label: "Contract Instance",
            live_until_ledger: instanceEntry.liveUntilLedgerSeq,
            last_modified_ledger: instanceEntry.lastModifiedLedgerSeq,
            discovery_source: "deterministic",
        });

        // Store WASM Entry if found
        if (wasmEntry) {
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: wasmEntry.entryKeyXdr,
                entry_type: "wasm",
                label: "WASM Code",
                live_until_ledger: wasmEntry.liveUntilLedgerSeq,
                last_modified_ledger: wasmEntry.lastModifiedLedgerSeq,
                discovery_source: "deterministic",
            });
        }

        // Store Manual Storage Entries
        for (const entry of extraEntries) {
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: entry.entryKeyXdr,
                entry_type: "persistent", // Defaulting to persistent for manual keys
                label: "Manual Storage Entry",
                live_until_ledger: entry.liveUntilLedgerSeq,
                last_modified_ledger: entry.lastModifiedLedgerSeq,
                discovery_source: "manual",
            });
        }

        // Store Introspected Entries
        for (const entry of introspectedEntries) {
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: entry.entryKeyXdr,
                entry_type: "persistent", // Defaulting to persistent for introspected keys
                label: "Introspected Storage Entry",
                live_until_ledger: entry.liveUntilLedgerSeq,
                last_modified_ledger: entry.lastModifiedLedgerSeq,
                discovery_source: "introspection",
            });
        }

        // Update last checked ledger
        updateLastCheckedLedger(db, contractId, instanceEntry.latestLedger);

        // ── Record successful introspection in the cache ───────────────────────
        updateLastIntrospectedAt(db, contractId, new Date().toISOString());

        return {
            success: true,
            contractId,
            instance: instanceEntry,
            wasm: wasmEntry,
            wasmWarning,
            fromCache: false,
        };

    } catch (error: any) {
        logger.error(`Error watching contract ${contractId}: ${error.message}`, error);
        return {
            success: false,
            contractId,
            error: error.message,
        };
    }
}


