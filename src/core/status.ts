import type Database from "better-sqlite3";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import type { ContractEntry } from "../db/repositories.js";
import {
    classifyTTL,
    formatTimeToCloseLedger,
    type TTLStatus,
} from "../utils/formatting.js";

export type EntryTTLStatus = TTLStatus | "unknown";

export type ContractStatusEntry = {
    label: string;
    entryType: string;
    entryKeyXdr: string;
    liveUntilLedger: number | null;
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    status: EntryTTLStatus;
};

export type ContractStatus = {
    contractId: string;
    name: string | null;
    network: string;
    lastCheckedLedger: number | null;
    entries: ContractStatusEntry[];
};

export class ContractNotFoundError extends Error {
    constructor(contractId: string) {
        super(`Contract ${contractId} is not registered.`);
        this.name = "ContractNotFoundError";
    }
}

function getEntryLabel(entry: ContractEntry): string {
    if (entry.entry_type === "instance") return "Instance";
    if (entry.entry_type === "wasm") return "WASM Code";
    return entry.label ?? entry.entry_type;
}

function mapEntryStatus(
    entry: ContractEntry,
    lastCheckedLedger: number | null,
): ContractStatusEntry {
    const label = getEntryLabel(entry);
    const liveUntilLedger = entry.live_until_ledger ?? null;

    if (liveUntilLedger == null || lastCheckedLedger == null) {
        return {
            label,
            entryType: entry.entry_type,
            entryKeyXdr: entry.entry_key_xdr,
            liveUntilLedger,
            remainingTTL: null,
            approximateTimeRemaining: null,
            status: "unknown",
        };
    }

    const remainingTTL = liveUntilLedger - lastCheckedLedger;
    const status = classifyTTL(remainingTTL);

    return {
        label,
        entryType: entry.entry_type,
        entryKeyXdr: entry.entry_key_xdr,
        liveUntilLedger,
        remainingTTL,
        approximateTimeRemaining: formatTimeToCloseLedger(remainingTTL),
        status,
    };
}

export function getContractStatus(db: Database.Database, contractId: string): ContractStatus {
    const contract = getContract(db, contractId);

    if (!contract) {
        throw new ContractNotFoundError(contractId);
    }

    const lastCheckedLedger = contract.last_checked_ledger ?? null;
    const entries = getEntriesForContract(db, contractId).map((entry) =>
        mapEntryStatus(entry, lastCheckedLedger),
    );

    return {
        contractId: contract.id,
        name: contract.name,
        network: contract.network,
        lastCheckedLedger,
        entries,
    };
}
