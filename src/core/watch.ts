import type Database from "better-sqlite3";
import { StellarRpcClient, ContractInstanceResult, SentinelLedgerEntryResult } from "../rpc/client";
import { insertContract, upsertEntry, updateLastCheckedLedger, getContract } from "../db/repositories";
import {getLogger} from "../logging";

const logger = getLogger()

export interface WatchOptions {
    contractId: string;
    network: string;
    name?: string;
    rpcUrl?: string;
    storageKeys?: string[];
}

export type WatchResult =
    | {
    success: true;
    contractId: string;
    instance: ContractInstanceResult;
    wasm: SentinelLedgerEntryResult | null;
    wasmWarning?: string;
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
    const { contractId, network, name, rpcUrl, storageKeys } = options;

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
        let wasmEntry: SentinelLedgerEntryResult | null = null;
        let wasmWarning: string | undefined;

        if (instanceEntry.wasmHash) {
            wasmEntry = await client.getWasmCodeEntry(instanceEntry.wasmHash);
            if (!wasmEntry) {
                wasmWarning = `WASM entry for hash ${instanceEntry.wasmHash} not found. It might be archived.`;
            }
        }

        // 3. Fetch Manual Storage Keys if provided
        const extraEntries: SentinelLedgerEntryResult[] = [];
        if (storageKeys && storageKeys.length > 0) {
            const ttls = await client.getEntryTTLs(storageKeys);
            extraEntries.push(...ttls.entries);
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

        // Update last checked ledger
        updateLastCheckedLedger(db, contractId, instanceEntry.latestLedger);
        logger.info(`Contract ${contractId} registered successfully on ${network}`);
        return {
            success: true,
            contractId,
            instance: instanceEntry,
            wasm: wasmEntry,
            wasmWarning,
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
