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

        const url = rpcUrl ?? RPC_URLS[network];
        if (!url) {
            result.error = `Unknown network "${network}"`;
            return result;
        }

    try {
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

        const txHashes = new Set<string>();
        for (const event of allEvents) {
            if (event.txHash) {
                txHashes.add(event.txHash);
            }
        }

        if (txHashes.size === 0) {
            logger.debug(`No events/transactions found for ${contractId} since ledger ${startLedger}`);
            return result;
        }

        result.transactionsScanned = txHashes.size;

        const rawContract = Buffer.from(contractId, "hex").length === 32
            ? Buffer.from(contractId, "hex")
            : decodeContractId(contractId);

        for (const txHash of txHashes) {
            try {
                const txResponse = await server.getTransaction(txHash);
                if (!txResponse.envelopeXdr) {
                    continue; // Skip if no envelope
                }

                // Parse envelope
                // For mock compatibility, handle if envelopeXdr is already an object or a base64 string
                const env = typeof txResponse.envelopeXdr === 'string'
                    ? xdr.TransactionEnvelope.fromXDR(txResponse.envelopeXdr as string, "base64")
                    : txResponse.envelopeXdr as any;

                let innerTx;
                if (env.switch().name === 'envelopeTypeTx') {
                    innerTx = env.v1().tx();
                } else if (env.switch().name === 'envelopeTypeTxFeeBump') {
                    innerTx = env.feeBump().tx().innerTx().v1().tx();
                }

                if (!innerTx) continue;

                const ext = innerTx.ext();
                if (ext.switch().value !== 1) continue;

                const sorobanData = ext.v1().sorobanData();
                const footprint = sorobanData.resources().footprint();

                const keys = [...footprint.readOnly(), ...footprint.readWrite()];

                for (const key of keys) {
                    if (key.switch().name === 'contractData') {
                        const contractData = key.contractData();
                        const contractAddr = contractData.contract();
                        
                        // Check if key belongs to our contract
                        if (contractAddr.switch().name === 'scAddressTypeContract') {
                            const addrRaw = contractAddr.contractId();
                            
                            // Compare raw contract address
                            if (Buffer.compare(Buffer.from(addrRaw), Buffer.from(rawContract)) === 0) {
                                const keyXdr = key.toXDR("base64");
                                
                                if (!existingKeys.has(keyXdr)) {
                                    existingKeys.add(keyXdr);
                                    
                                    // Identify type (persistent, temporary, instance)
                                    let entryType = "persistent";
                                    if (contractData.durability().name === "temporary") entryType = "temporary";
                                    if (contractData.key().switch().name === "scvLedgerKeyContractInstance") entryType = "instance";
                                    
                                    upsertEntry(db, {
                                        contract_id: contractId,
                                        entry_key_xdr: keyXdr,
                                        entry_type: entryType,
                                        label: `Discovered (footprint)`,
                                        live_until_ledger: 0, // We could fetch from getLedgerEntries if we want TTL, but we can do that in a sync pass
                                        last_modified_ledger: 0,
                                        discovery_source: "footprint",
                                    });
                                    result.newKeysDiscovered++;
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                logger.debug(`Failed to parse transaction footprint for ${contractId} (tx: ${txHash}): ${err}`);
            }
        }

        logger.debug(
            `Discovery for ${contractId}: scanned ${result.transactionsScanned} transactions, ` +
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
