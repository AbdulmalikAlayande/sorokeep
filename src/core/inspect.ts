import type Database from "better-sqlite3";
import { xdr, Address, StrKey, scValToNative } from "@stellar/stellar-sdk";
import { getContract } from "../db/repositories.js";
import { StellarRpcClient } from "../rpc/client.js";
import { classifyTTL, formatTimeToCloseLedger, formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "InspectCore" });

export interface InspectOptions {
    entries?: string[];
    network?: string;
    rpcUrl?: string;
}

export interface InspectEntryInfo {
    inputEntry: string;
    entryKeyXdr: string;
    type: "balance" | "raw";
    found: boolean;
    remainingTTL?: number | null;
    approximateTimeRemaining?: string | null;
    status?: string;
    balance?: {
        amount: bigint;
        authorized: boolean;
        clawback: boolean;
    };
    formattedBalance?: string;
}

export interface InspectResult {
    success: boolean;
    contractId: string;
    contractName?: string | null;
    network?: string;
    isSac?: boolean;
    decimals?: number;
    results?: InspectEntryInfo[];
    error?: string;
}

/**
 * Format token balance in stroops/raw units to string representation with decimals.
 */
export function formatTokenBalance(amount: bigint | number | string, decimals: number): string {
    const bigAmount = BigInt(amount);
    const isNegative = bigAmount < 0n;
    const absAmount = isNegative ? -bigAmount : bigAmount;
    const divisor = 10n ** BigInt(decimals);
    const integerPart = absAmount / divisor;
    const remainder = absAmount % divisor;

    let result = integerPart.toString();
    if (decimals > 0) {
        const remainderStr = remainder.toString().padStart(decimals, "0");
        const trimmedRemainder = remainderStr.replace(/0+$/, "");
        if (trimmedRemainder.length > 0) {
            result += "." + trimmedRemainder;
        }
    }
    return isNegative ? "-" + result : result;
}

/**
 * Custom parser for SAC balance map layout.
 */
export function parseSacBalance(scVal: xdr.ScVal | string): { amount: bigint; authorized: boolean; clawback: boolean } {
    let valObj: xdr.ScVal;
    if (typeof scVal === "string") {
        try {
            valObj = xdr.ScVal.fromXDR(scVal, "base64");
        } catch {
            throw new Error("Invalid SAC balance map layout");
        }
    } else {
        valObj = scVal;
    }

    if (!valObj || typeof valObj.switch !== "function" || valObj.switch().name !== "scvMap") {
        throw new Error("Invalid SAC balance map layout");
    }

    let native: any;
    try {
        native = scValToNative(valObj);
    } catch {
        throw new Error("Invalid SAC balance map layout");
    }

    if (!native || typeof native !== "object" || native.amount === undefined) {
        throw new Error("Invalid SAC balance map layout");
    }

    return {
        amount: BigInt(native.amount),
        authorized: Boolean(native.authorized ?? true),
        clawback: Boolean(native.clawback ?? false),
    };
}

/**
 * Build storage key XDR for a SAC address balance entry.
 */
export function buildSacBalanceKeyXdr(contractId: string, address: string): string {
    const addr = Address.fromString(address);
    const keyVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Balance"),
        addr.toScVal(),
    ]);

    const raw = Buffer.from(contractId, "hex").length === 32
        ? Buffer.from(contractId, "hex")
        : Buffer.from(StrKey.decodeContract(contractId));

    const contractAddress = xdr.ScAddress.scAddressTypeContract(
        raw as unknown as xdr.Hash,
    );

    const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contractAddress,
            key: keyVal,
            durability: xdr.ContractDataDurability.persistent(),
        }),
    );

    return ledgerKey.toXDR("base64");
}

/**
 * Inspect contract storage and token balances on SAC contracts.
 */
export async function inspectContract(
    db: Database.Database,
    contractId: string,
    options: InspectOptions = {},
): Promise<InspectResult> {
    let contract: { name?: string | null; network: string; rpc_url?: string | null } | null | undefined = null;
    try {
        contract = getContract(db, contractId);
    } catch {
        // DB not initialized or not found
    }

    const network = contract?.network ?? options.network ?? "testnet";
    const rpcUrl = contract?.rpc_url ?? options.rpcUrl;
    const contractName = contract?.name ?? null;

    const client = new StellarRpcClient(network, rpcUrl ?? undefined);

    // 1. Check if SAC contract
    const instance = await client.getContractInstanceEntry(contractId);
    if (!instance) {
        return {
            success: false,
            contractId,
            error: `Contract instance not found on-chain for ${formatContractID(contractId)} (or non-SAC contract).`,
        };
    }

    if (instance.executableType !== "contractExecutableStellarAsset") {
        return {
            success: false,
            contractId,
            error: `Contract ${formatContractID(contractId)} is not a standard Stellar Asset Contract (SAC). Executable type: ${instance.executableType}`,
        };
    }

    // 2. Fetch SAC decimals
    const decimals = await client.getSacDecimals(contractId);

    // 3. Process entries
    const inputEntries = options.entries ?? [];
    if (inputEntries.length === 0) {
        return {
            success: true,
            contractId,
            contractName,
            network,
            isSac: true,
            decimals,
            results: [],
        };
    }

    const mapped: { inputEntry: string; entryKeyXdr: string; type: "balance" | "raw" }[] = [];

    for (const inputEntry of inputEntries) {
        if (inputEntry.startsWith("balance:")) {
            const address = inputEntry.slice("balance:".length).trim();
            try {
                const keyXdr = buildSacBalanceKeyXdr(contractId, address);
                mapped.push({ inputEntry, entryKeyXdr: keyXdr, type: "balance" });
            } catch (err: any) {
                return {
                    success: false,
                    contractId,
                    error: `Failed to locate balance slot for address "${address}": ${err.message ?? String(err)}`,
                };
            }
        } else {
            mapped.push({ inputEntry, entryKeyXdr: inputEntry, type: "raw" });
        }
    }

    const keyXdrs = mapped.map(m => m.entryKeyXdr);
    const storageEntries = await client.getContractStorageEntries(keyXdrs);
    const entryMap = new Map(storageEntries.map(e => [e.entryKeyXdr, e]));

    const results: InspectEntryInfo[] = mapped.map(item => {
        const foundEntry = entryMap.get(item.entryKeyXdr);
        if (!foundEntry || !foundEntry.valXdr) {
            if (item.type === "balance") {
                return {
                    inputEntry: item.inputEntry,
                    entryKeyXdr: item.entryKeyXdr,
                    type: "balance",
                    found: false,
                    remainingTTL: null,
                    approximateTimeRemaining: null,
                    status: "unknown",
                    balance: { amount: 0n, authorized: true, clawback: false },
                    formattedBalance: formatTokenBalance(0n, decimals),
                };
            } else {
                return {
                    inputEntry: item.inputEntry,
                    entryKeyXdr: item.entryKeyXdr,
                    type: "raw",
                    found: false,
                    remainingTTL: null,
                    approximateTimeRemaining: null,
                    status: "unknown",
                };
            }
        }

        const remTTL = foundEntry.remainingTTL;
        const ttlStatus = classifyTTL(remTTL);
        const approxTime = formatTimeToCloseLedger(remTTL);

        if (item.type === "balance") {
            let bal = { amount: 0n, authorized: true, clawback: false };
            try {
                bal = parseSacBalance(foundEntry.valXdr);
            } catch {
                logger.debug("Failed to decode balance valXdr", { valXdr: foundEntry.valXdr });
            }
            return {
                inputEntry: item.inputEntry,
                entryKeyXdr: item.entryKeyXdr,
                type: "balance",
                found: true,
                remainingTTL: remTTL,
                approximateTimeRemaining: approxTime,
                status: ttlStatus,
                balance: bal,
                formattedBalance: formatTokenBalance(bal.amount, decimals),
            };
        } else {
            return {
                inputEntry: item.inputEntry,
                entryKeyXdr: item.entryKeyXdr,
                type: "raw",
                found: true,
                remainingTTL: remTTL,
                approximateTimeRemaining: approxTime,
                status: ttlStatus,
            };
        }
    });

    return {
        success: true,
        contractId,
        contractName,
        network,
        isSac: true,
        decimals,
        results,
    };
}
