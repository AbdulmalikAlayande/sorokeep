import Database from "better-sqlite3";
import { classifyRemainingTTL, formatTimeToCloseLedger, type TtlBucket } from "./ttlStatus.js";

/**
 * Read-only access to sorokeep's local SQLite database.
 *
 * Safety design (per issue #437): the extension never WRITES to the database
 * and opens it read-only (`fileMustExist: true, readonly: true`). A running
 * sorokeep daemon may hold the database in WAL mode; SQLite permits a read-only
 * connection to a WAL database as long as the -shm/-wal files are accessible.
 * For environments where even that is blocked (read-only FS, locked shm), the
 * "immutable" read mode opens the single database file and ignores WAL,
 * trading freshness for guarantee-it-never-forks.
 *
 * Every open is wrapped so a missing/locked/corrupt database fails gracefully
 * (returns null) instead of crashing the extension.
 */

export interface ContractEntryTtl {
    label: string | null;
    entryType: string;
    liveUntilLedger: number | null;
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    status: TtlBucket;
}

export interface ContractTtlStatus {
    contractId: string;
    name: string | null;
    network: string;
    lastCheckedLedger: number | null;
    /** Aggregated most-urgent remaining TTL (see reduceContractStatus). */
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    status: TtlBucket;
    entries: ContractEntryTtl[];
}

export interface SorokeepDbHandle {
    db: Database.Database;
    close(): void;
}

export type SorokeepDbFactory = () => SorokeepDbHandle | null;

export type DbReadMode = "readonly" | "immutable";

export interface OpenSorokeepOptions {
    readMode: DbReadMode;
}

interface ContractRow {
    id: string;
    name: string | null;
    network: string;
    last_checked_ledger: number | null;
}

interface EntryRow {
    entry_type: string;
    label: string | null;
    live_until_ledger: number | null;
}

/**
 * Open the sorokeep database read-only. Returns null on any failure (missing
 * file, locked shm, corrupt db, ...) so callers degrade gracefully.
 */
export function openSorokeepDb(filePath: string, options: OpenSorokeepOptions): Database.Database | null {
    try {
        // `immutable` is a real better-sqlite3 option but is missing from its
        // bundled types; cast explicitly rather than dropping WAL-safety tradeoff.
        const opts = options.readMode === "immutable"
            ? { readonly: true, immutable: true, fileMustExist: true }
            : { readonly: true, fileMustExist: true };
        return new Database(filePath, opts as Database.Options);
    } catch {
        return null;
    }
}

/**
 * Look up the TTL status for a single contract. Returns null when the contract
 * is not tracked by sorokeep — which is what prevents a false-positive CodeLens.
 */
export function readContractStatus(db: Database.Database, contractId: string): ContractTtlStatus | null {
    const contract = db
        .prepare("SELECT id, name, network, last_checked_ledger FROM contracts WHERE id = ?")
        .get(contractId) as ContractRow | undefined;

    if (!contract) return null;

    const lastCheckedLedger = contract.last_checked_ledger ?? null;
    const rows = db
        .prepare("SELECT entry_type, label, live_until_ledger FROM contract_entries WHERE contract_id = ?")
        .all(contractId) as EntryRow[];

    const entries: ContractEntryTtl[] = rows.map((row) => {
        const liveUntilLedger = row.live_until_ledger ?? null;
        let remainingTTL: number | null = null;
        let approximateTimeRemaining: string | null = null;
        let status: TtlBucket = "unknown";

        if (liveUntilLedger != null && lastCheckedLedger != null) {
            remainingTTL = liveUntilLedger - lastCheckedLedger;
            approximateTimeRemaining = formatTimeToCloseLedger(remainingTTL);
            status = classifyRemainingTTL(remainingTTL);
        }

        return {
            label: row.label ?? row.entry_type,
            entryType: row.entry_type,
            liveUntilLedger,
            remainingTTL,
            approximateTimeRemaining,
            status,
        };
    });

    // Aggregate: most urgent entry drives the inline status.
    const known = entries.filter((e) => e.remainingTTL != null);
    let aggregate: { remainingTTL: number; approximateTimeRemaining: string | null; status: TtlBucket } | null = null;
    if (known.length > 0) {
        const worst = known.reduce((a, b) => (a.remainingTTL! <= b.remainingTTL! ? a : b));
        aggregate = {
            remainingTTL: worst.remainingTTL!,
            approximateTimeRemaining: worst.approximateTimeRemaining ?? null,
            status: worst.status,
        };
    }

    return {
        contractId: contract.id,
        name: contract.name,
        network: contract.network,
        lastCheckedLedger,
        remainingTTL: aggregate?.remainingTTL ?? null,
        approximateTimeRemaining: aggregate?.approximateTimeRemaining ?? null,
        status: aggregate?.status ?? "unknown",
        entries,
    };
}