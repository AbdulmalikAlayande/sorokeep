import { StellarRpcClient } from "../rpc/client.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "CheckCommand" });

export interface CheckEntry {
    entryKeyXdr: string;
    entryType: "instance" | "wasm";
    liveUntilLedger: number;
    remainingTTL: number;
}

export interface CheckResult {
    contractId: string;
    network: string;
    threshold: number;
    latestLedger: number;
    minimumTTL: number;
    passed: boolean;
    entries: CheckEntry[];
    error?: string;
}

/**
 * One-shot, stateless TTL check for a Soroban contract.
 *
 * Queries the Stellar RPC directly — no local DB required.
 * Checks both the contract instance and its WASM code entry (when present).
 * Returns `passed: true` when minimumTTL >= threshold.
 */
export async function checkContractTTL(
    contractId: string,
    network: string,
    threshold: number,
    rpcUrl?: string,
): Promise<CheckResult> {
    const client = new StellarRpcClient(network, rpcUrl);
    const entries: CheckEntry[] = [];

    try {
        const instanceEntry = await client.getContractInstanceEntry(contractId);

        if (!instanceEntry) {
            return {
                contractId,
                network,
                threshold,
                latestLedger: 0,
                minimumTTL: 0,
                passed: false,
                entries: [],
                error: `Contract ${contractId} not found on ${network}`,
            };
        }

        entries.push({
            entryKeyXdr: instanceEntry.entryKeyXdr,
            entryType: "instance",
            liveUntilLedger: instanceEntry.liveUntilLedgerSeq,
            remainingTTL: instanceEntry.remainingTTL,
        });

        if (instanceEntry.wasmHash) {
            const wasmEntry = await client.getWasmCodeEntry(instanceEntry.wasmHash);
            if (wasmEntry) {
                entries.push({
                    entryKeyXdr: wasmEntry.entryKeyXdr,
                    entryType: "wasm",
                    liveUntilLedger: wasmEntry.liveUntilLedgerSeq,
                    remainingTTL: wasmEntry.remainingTTL,
                });
            } else {
                return {
                    contractId,
                    network,
                    threshold,
                    latestLedger: instanceEntry.latestLedger,
                    minimumTTL: 0,
                    passed: false,
                    entries,
                    error: `WASM code entry (hash: ${instanceEntry.wasmHash.substring(0, 10)}...) not found`,
                };
            }
        }

        const minimumTTL = Math.min(...entries.map(e => e.remainingTTL));
        const passed = minimumTTL >= threshold;

        logger.debug(
            `TTL check — contract: ${contractId}, minimumTTL: ${minimumTTL}, threshold: ${threshold}, passed: ${passed}`,
        );

        return {
            contractId,
            network,
            threshold,
            latestLedger: instanceEntry.latestLedger,
            minimumTTL,
            passed,
            entries,
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`TTL check failed for ${contractId}: ${message}`);
        return {
            contractId,
            network,
            threshold,
            latestLedger: 0,
            minimumTTL: 0,
            passed: false,
            entries: [],
            error: message,
        };
    }
}
