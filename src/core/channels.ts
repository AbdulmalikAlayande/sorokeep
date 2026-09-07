import type Database from "better-sqlite3";
import { Keypair } from "@stellar/stellar-sdk";
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

/**
 * Zeroize the raw secret key buffer of a Stellar Keypair after use.
 *
 * The Stellar SDK's `Keypair.rawSecretKey()` returns the **same** underlying
 * ArrayBuffer that backs the keypair's internal secret-key storage (verified
 * against @stellar/stellar-sdk). Filling that buffer with zeros therefore
 * removes the key material from the Keypair object's memory immediately,
 * rather than leaving it live until the garbage collector reclaims the object.
 *
 * ⚠️  Defense-in-depth limitations (be honest, not marketing):
 * - The original secret key *string* (the "S…" stroop passed to
 *   `Keypair.fromSecret`) is a JavaScript primitive. Strings are immutable and
 *   may be interned by V8. There is no portable way to zero a JS string, so
 *   that copy of the key material will persist until GC collects it.
 * - V8's heap compaction may have duplicated the Buffer's bytes elsewhere in
 *   memory before this function is called. No hard erasure guarantee is
 *   possible in a garbage-collected runtime.
 * - This function only zeroes the keypair it receives. It has no effect on
 *   keypairs created inside other functions (e.g., inside `client.sendPayments`
 *   in rpc/client.ts) — those are out of scope per issue #428.
 *
 * Despite these limitations, zeroing the buffer shortens the window in which a
 * memory scrape or heap dump can recover the raw key material, which is a
 * meaningful improvement over leaving the bytes live indefinitely.
 *
 * @param keypair - The Stellar Keypair whose secret key buffer should be zeroed.
 */
export function zeroizeKeypair(keypair: Keypair): void {
    keypair.rawSecretKey().fill(0);
}

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
                    const response = await (client as unknown as { getAccount: (pk: string) => Promise<{ balances?: Array<{ asset_type: string; balance: string }> }> }).getAccount(account.public_key);
                    const nativeBalance = response.balances?.find(
                        (b) => b.asset_type === "native",
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

    // Create a local Keypair so we can zero its buffer immediately after the
    // payment completes. The signing copy held inside client.sendPayments()
    // is a separate object in rpc/client.ts and is outside the scope of this
    // function; see the zeroizeKeypair() doc comment for the full picture.
    const keypair = Keypair.fromSecret(masterSecretKey);

    let result;
    try {
        result = await client.sendPayments(destinations, masterSecretKey);
    } finally {
        // Zero the raw key buffer in all outcomes — success, failure, or thrown
        // error. This shortens the window the key material sits in this
        // Keypair object's backing buffer. See zeroizeKeypair() for limits.
        zeroizeKeypair(keypair);
    }

    if (!result.success) {
        return { funded: 0, txHash: result.txHash, errors: [result.error ?? "Transaction failed"] };
    }

    for (const account of accounts) {
        markChannelFunded(db, account.public_key);
    }

    return { funded: accounts.length, txHash: result.txHash, errors: [] };
}
