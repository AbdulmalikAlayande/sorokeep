import type Database from "better-sqlite3";
import { StellarRpcClient } from "../rpc/client.js";
import {
    getChannelAccounts,
    updateChannelBalance,
    insertChannelAccount,
    markChannelFunded,
    type ChannelAccount,
} from "../db/repositories.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "ChannelAccountPool" });

export interface ChannelSlot {
    publicKey: string;
    keypairSource: string | null;
}

export interface ChannelBalance {
    publicKey: string;
    balanceXlm: number | null;
    balanceCheckedAt: string | null;
}

/**
 * Pool of channel accounts for concurrent TTL extensions.
 *
 * Each account tracks its own sequence number on Stellar, so concurrent
 * transactions submitted through different accounts avoid sequence conflicts.
 * acquire() hands out a slot in round-robin order, blocking callers until
 * a slot is free. release() returns the slot and unblocks the next waiter.
 */
export class ChannelAccountPool {
    private readonly db: Database.Database;
    private readonly network: string;
    private readonly accounts: ChannelAccount[];
    /** Tracks which publicKeys are currently in use. */
    private readonly inUse = new Set<string>();
    /** Queue of resolve callbacks waiting for the next free slot. */
    private readonly waiters: Array<(slot: ChannelSlot) => void> = [];
    /** Round-robin cursor. */
    private cursor = 0;

    constructor(db: Database.Database, network: string) {
        this.db = db;
        this.network = network;
        this.accounts = getChannelAccounts(db, network);
    }

    /** Number of registered channel accounts. */
    size(): number {
        return this.accounts.length;
    }

    /**
     * Acquire an available channel account slot.
     * If all slots are in use, waits until one is released.
     */
    acquire(): Promise<ChannelSlot> {
        const slot = this.nextFreeSlot();
        if (slot) {
            this.inUse.add(slot.publicKey);
            return Promise.resolve(slot);
        }

        // All slots busy — queue the caller
        return new Promise<ChannelSlot>(resolve => {
            this.waiters.push(resolve);
        });
    }

    /**
     * Release a slot back to the pool.
     * Unblocks the oldest waiting acquire() call if any.
     */
    release(publicKey: string): void {
        this.inUse.delete(publicKey);

        if (this.waiters.length > 0) {
            const slot = this.nextFreeSlot();
            if (slot) {
                this.inUse.add(slot.publicKey);
                this.waiters.shift()!(slot);
            }
        }
    }

    /**
     * Returns current balance information for all accounts in the pool.
     * Reads from the DB — does not call the RPC.
     */
    getBalances(): ChannelBalance[] {
        return getChannelAccounts(this.db, this.network).map(a => ({
            publicKey: a.public_key,
            balanceXlm: a.balance_xlm,
            balanceCheckedAt: a.balance_checked_at,
        }));
    }

    /**
     * Fetch native XLM balances for all accounts from the RPC and persist them.
     * Errors per-account are logged and swallowed — does not throw.
     */
    async refreshBalances(rpcUrl?: string): Promise<void> {
        if (this.accounts.length === 0) return;

        const client = new StellarRpcClient(this.network, rpcUrl);

        await Promise.all(
            this.accounts.map(async account => {
                try {
                    const response = await (client as any).getAccount(account.public_key);
                    const nativeBalance = response.balances?.find(
                        (b: any) => b.asset_type === "native",
                    );
                    const xlm = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
                    updateChannelBalance(this.db, account.public_key, xlm);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`Failed to refresh balance for ${account.public_key}: ${msg}`);
                }
            }),
        );
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Find the next free account in round-robin order.
     * Returns undefined if all accounts are in use.
     */
    private nextFreeSlot(): ChannelSlot | undefined {
        const n = this.accounts.length;
        for (let i = 0; i < n; i++) {
            const idx = (this.cursor + i) % n;
            const account = this.accounts[idx]!;
            if (!this.inUse.has(account.public_key)) {
                this.cursor = (idx + 1) % n;
                return { publicKey: account.public_key, keypairSource: account.keypair_source };
            }
        }
        return undefined;
    }
}

export interface FundChannelsResult {
    funded: number;
    txHash: string;
    errors: string[];
}

export function addChannel(
    db: Database.Database,
    publicKey: string,
    network: string,
    label?: string,
): void {
    insertChannelAccount(db, { public_key: publicKey, network, label });
}

export function listChannels(db: Database.Database, network: string): ChannelAccount[] {
    return getChannelAccounts(db, network);
}

export async function fundChannels(
    db: Database.Database,
    masterSecretKey: string,
    amountXlm: string,
    network: string,
    rpcUrl?: string,
): Promise<FundChannelsResult> {
    const accounts = getChannelAccounts(db, network);
    if (accounts.length === 0) {
        return { funded: 0, txHash: "", errors: [] };
    }

    const client = new StellarRpcClient(network, rpcUrl);
    const destinations = accounts.map((a) => ({
        publicKey: a.public_key,
        amountXlm,
    }));

    const result = await client.sendPayments(destinations, masterSecretKey);

    if (!result.success) {
        return { funded: 0, txHash: result.txHash, errors: [result.error ?? "Transaction failed"] };
    }

    for (const account of accounts) {
        markChannelFunded(db, account.public_key);
    }

    return { funded: accounts.length, txHash: result.txHash, errors: [] };
}
