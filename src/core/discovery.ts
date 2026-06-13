import type Database from "better-sqlite3";
import { rpc, xdr, StrKey } from "@stellar/stellar-sdk";
import { getEntriesForContract, upsertEntry, getAllContracts } from "../db/repositories.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "Discovery" });

// ─── Public contract ──────────────────────────────────────────────────────────

export interface DiscoveryResult {
    /** Contract ID that was scanned. */
    contractId: string;
    /** Number of new storage keys discovered. */
    newKeysDiscovered: number;
    /** Total transactions scanned. */
    transactionsScanned: number;
    /** Error message if discovery failed. */
    error?: string;
}

export interface BatchDiscoveryResult {
    /** Total contracts scanned. */
    contractsScanned: number;
    /** Total new keys discovered across all contracts. */
    totalNewKeys: number;
    /** Per-contract results. */
    results: DiscoveryResult[];
    /** Errors that occurred during discovery. */
    errors: string[];
}

// ─── RPC URLs ──────────────────────────────────────────────────────────────────

const RPC_URLS: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://mainnet.sorobanrpc.com",
};

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * Discover new storage keys for a contract by scanning recent transactions.
 *
 * Uses the Stellar RPC `getEvents` endpoint to find contract invocation events,
 * then extracts ledger keys from the event data to discover persistent and
 * temporary storage entries that the contract has touched.
 *
 * This is Layer 2 of the discovery architecture — it learns keys over time
 * from observed contract activity.
 */
export async function discoverStorageKeys(
    db: Database.Database,
    contractId: string,
    network: string,
    rpcUrl?: string,
): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
        contractId,
        newKeysDiscovered: 0,
        transactionsScanned: 0,
    };

    try {
        const url = rpcUrl ?? RPC_URLS[network];
        if (!url) {
            result.error = `Unknown network "${network}"`;
            return result;
        }

        const server = new rpc.Server(url);

        // Get the latest ledger to set up the event window
        const health = await server.getHealth();
        const latestLedger = (health as any).latestLedger ?? 0;
        if (latestLedger === 0) {
            result.error = "Could not determine latest ledger";
            return result;
        }

        // Look back ~1 hour of ledgers (approximately 655 ledgers at 5.5s/ledger)
        // The RPC limits event lookback, so we use a reasonable window
        const startLedger = Math.max(1, latestLedger - 655);

        // Get existing entry keys so we can identify new ones
        const existingEntries = getEntriesForContract(db, contractId);
        const existingKeys = new Set(existingEntries.map(e => e.entry_key_xdr));

        // Fetch events for this contract with cursor-based pagination
        const allEvents: rpc.Api.EventResponse[] = [];
        let cursor: string | undefined;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const request: any = {
                filters: [
                    {
                        type: "contract",
                        contractIds: [contractId],
                    },
                ],
                limit: 100,
            };

            if (cursor) {
                request.pagination = { cursor };
            } else {
                request.startLedger = startLedger;
            }

            const page = await server.getEvents(request);
            if (page.events && page.events.length > 0) {
                allEvents.push(...page.events);
            }

            // Continue if there's a cursor for the next page
            if ((page as any).cursor && page.events && page.events.length === 100) {
                cursor = (page as any).cursor;
            } else {
                break;
            }
        }

        if (allEvents.length === 0) {
            logger.debug(`No events found for ${contractId} since ledger ${startLedger}`);
            return result;
        }

        result.transactionsScanned = allEvents.length;

        // For each event, try to extract ledger keys from the event data.
        // Contract storage events often encode the storage key in the topic.
        for (const event of allEvents) {
            try {
                // Events have topic entries that may contain storage key references
                if (event.topic && event.topic.length > 0) {
                    for (const topicVal of event.topic) {
                        // Try to interpret topic values as potential ledger keys
                        // This is heuristic — not all topic values are storage keys
                        try {
                            const keyXdr = topicVal.toXDR("base64");
                            if (!existingKeys.has(keyXdr) && keyXdr.length > 10) {
                                // Construct a contract data ledger key from this
                                const contractDataKey = buildContractDataKey(contractId, topicVal);
                                if (contractDataKey) {
                                    const contractDataKeyXdr = contractDataKey.toXDR("base64");
                                    if (!existingKeys.has(contractDataKeyXdr)) {
                                        // Verify the entry exists on-chain before adding
                                        const entryResponse = await server.getLedgerEntries(contractDataKey);
                                        if (entryResponse.entries && entryResponse.entries.length > 0) {
                                            const entry = entryResponse.entries[0]!;
                                            upsertEntry(db, {
                                                contract_id: contractId,
                                                entry_key_xdr: contractDataKeyXdr,
                                                entry_type: "persistent",
                                                label: `Discovered (event)`,
                                                live_until_ledger: entry.liveUntilLedgerSeq ?? 0,
                                                last_modified_ledger: entry.lastModifiedLedgerSeq ?? 0,
                                                discovery_source: "footprint",
                                            });
                                            existingKeys.add(contractDataKeyXdr);
                                            result.newKeysDiscovered++;
                                        }
                                    }
                                }
                            }
                        } catch {
                            // Not a valid key — skip
                        }
                    }
                }
            } catch (err) {
                // Individual event parsing failure — continue
                logger.debug(`Failed to parse event for ${contractId}: ${err}`);
            }
        }

        logger.debug(
            `Discovery for ${contractId}: scanned ${result.transactionsScanned} events, ` +
            `found ${result.newKeysDiscovered} new keys`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.error = message;
        logger.error(`Discovery failed for ${contractId}: ${message}`, err);
    }

    return result;
}

/**
 * Run discovery for all registered contracts on a network.
 * Called by the daemon as an optional step after the monitor cycle.
 */
export async function runBatchDiscovery(
    db: Database.Database,
    network: string,
    rpcUrl?: string,
): Promise<BatchDiscoveryResult> {
    const batchResult: BatchDiscoveryResult = {
        contractsScanned: 0,
        totalNewKeys: 0,
        results: [],
        errors: [],
    };

    const contracts = getAllContracts(db).filter(c => c.network === network);

    for (const contract of contracts) {
        batchResult.contractsScanned++;

        try {
            const result = await discoverStorageKeys(db, contract.id, network, rpcUrl);
            batchResult.results.push(result);
            batchResult.totalNewKeys += result.newKeysDiscovered;

            if (result.error) {
                batchResult.errors.push(`${contract.id}: ${result.error}`);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            batchResult.errors.push(`${contract.id}: ${message}`);
        }
    }

    return batchResult;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Attempt to build a contract data ledger key from a contract ID and an XDR value.
 * Returns null if the construction fails.
 */
function buildContractDataKey(
    contractId: string,
    keyVal: xdr.ScVal,
): xdr.LedgerKey | null {
    try {
        const raw = Buffer.from(contractId, "hex").length === 32
            ? Buffer.from(contractId, "hex")
            : decodeContractId(contractId);
        const contractAddress = xdr.ScAddress.scAddressTypeContract(
            raw as unknown as xdr.Hash,
        );

        return xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: contractAddress,
                key: keyVal,
                durability: xdr.ContractDataDurability.persistent(),
            }),
        );
    } catch {
        return null;
    }
}

/**
 * Decode a Stellar contract ID (C...) to raw 32-byte buffer.
 */
function decodeContractId(contractId: string): Buffer {
    try {
        return Buffer.from(StrKey.decodeContract(contractId));
    } catch {
        // Fallback: assume hex
        return Buffer.from(contractId, "hex");
    }
}
