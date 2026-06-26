import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    upsertChannelAccount,
    getChannelAccounts,
    updateChannelBalance,
    deleteChannelAccount,
} from "../../src/db/repositories.js";

// ─── Mock RPC client ────────────────────────────────────────────────────────

const mockGetCurrentLedger = vi.fn();
const mockSubmitExtension = vi.fn();
const mockGetEntryTTLs = vi.fn();
const mockGetAccount = vi.fn();

vi.mock("../../src/rpc/client.js", () => ({
    StellarRpcClient: class {
        getCurrentLedger = mockGetCurrentLedger;
        submitExtension = mockSubmitExtension;
        getEntryTTLs = mockGetEntryTTLs;
        getAccount = mockGetAccount;
    },
}));

const { ChannelAccountPool } = await import("../../src/core/channels.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

let seedCounter = 0;

function seedAccounts(db: Database.Database, n: number, network = "testnet") {
    const accounts = Array.from({ length: n }, () => {
        seedCounter++;
        const suffix = String(seedCounter).padStart(50, "A");
        return {
            public_key: `G${suffix}`,
            keypair_source: `env:SECRET_KEY_${seedCounter}`,
            network,
        };
    });
    for (const a of accounts) upsertChannelAccount(db, a);
    return accounts;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChannelAccountPool", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        seedCounter = 0;
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Construction & DB integration
    // =========================================================================
    describe("construction", () => {
        it("loads channel accounts from the database", () => {
            seedAccounts(db, 3);
            const pool = new ChannelAccountPool(db, "testnet");
            expect(pool.size()).toBe(3);
        });

        it("returns size 0 when no accounts registered", () => {
            const pool = new ChannelAccountPool(db, "testnet");
            expect(pool.size()).toBe(0);
        });

        it("only loads accounts for the specified network", () => {
            seedAccounts(db, 2, "testnet");
            seedAccounts(db, 1, "mainnet");
            const pool = new ChannelAccountPool(db, "testnet");
            expect(pool.size()).toBe(2);
        });
    });

    // =========================================================================
    // 2. Round-robin allocation
    // =========================================================================
    describe("round-robin allocation", () => {
        it("acquires each account in order before repeating", async () => {
            const accounts = seedAccounts(db, 3);
            const pool = new ChannelAccountPool(db, "testnet");

            const first = await pool.acquire();
            const second = await pool.acquire();
            const third = await pool.acquire();

            expect([first.publicKey, second.publicKey, third.publicKey]).toEqual(
                accounts.map(a => a.public_key),
            );

            // Release all before cycling again
            pool.release(first.publicKey);
            pool.release(second.publicKey);
            pool.release(third.publicKey);

            // Next acquisition wraps back to the first
            const fourth = await pool.acquire();
            expect(fourth.publicKey).toBe(accounts[0]!.public_key);
            pool.release(fourth.publicKey);
        });

        it("acquire resolves with publicKey and keypairSource", async () => {
            seedAccounts(db, 1);
            const pool = new ChannelAccountPool(db, "testnet");
            const slot = await pool.acquire();
            expect(slot.publicKey).toMatch(/^G/);
            expect(slot.keypairSource).toMatch(/^env:/);
            pool.release(slot.publicKey);
        });

        it("waits when all accounts are in-use and resolves once one is released", async () => {
            seedAccounts(db, 1);
            const pool = new ChannelAccountPool(db, "testnet");

            const first = await pool.acquire();

            let resolved = false;
            const pending = pool.acquire().then(slot => {
                resolved = true;
                return slot;
            });

            // Give the event loop a tick — should still be waiting
            await new Promise(r => setTimeout(r, 10));
            expect(resolved).toBe(false);

            pool.release(first.publicKey);

            const second = await pending;
            expect(resolved).toBe(true);
            expect(second.publicKey).toBe(first.publicKey);
            pool.release(second.publicKey);
        });
    });

    // =========================================================================
    // 3. Parallel extensions without sequence conflicts
    // =========================================================================
    describe("parallel extensions without sequence conflicts", () => {
        it("assigns a distinct account per concurrent task", async () => {
            seedAccounts(db, 3);
            const pool = new ChannelAccountPool(db, "testnet");

            const assigned: string[] = [];
            const tasks = Array.from({ length: 3 }, async () => {
                const slot = await pool.acquire();
                assigned.push(slot.publicKey);
                await new Promise(r => setTimeout(r, 5)); // simulate work
                pool.release(slot.publicKey);
            });

            await Promise.all(tasks);
            const unique = new Set(assigned);
            // All 3 tasks used different accounts — no sharing while in-flight
            expect(unique.size).toBe(3);
        });

        it("executes more tasks than accounts sequentially through the pool", async () => {
            seedAccounts(db, 2);
            const pool = new ChannelAccountPool(db, "testnet");

            const order: string[] = [];
            const tasks = Array.from({ length: 4 }, async (_, i) => {
                const slot = await pool.acquire();
                order.push(`task${i}:${slot.publicKey}`);
                await new Promise(r => setTimeout(r, 5));
                pool.release(slot.publicKey);
            });

            await Promise.all(tasks);
            // All 4 tasks completed
            expect(order.length).toBe(4);
            // Each task used a valid public key
            for (const entry of order) {
                expect(entry).toMatch(/^task\d:G/);
            }
        });
    });

    // =========================================================================
    // 4. Balance reporting
    // =========================================================================
    describe("balance reporting", () => {
        it("returns balances from the database", () => {
            const accounts = seedAccounts(db, 2);
            updateChannelBalance(db, accounts[0]!.public_key, 100.5);
            updateChannelBalance(db, accounts[1]!.public_key, 50.25);

            const pool = new ChannelAccountPool(db, "testnet");
            const balances = pool.getBalances();

            expect(balances).toHaveLength(2);
            expect(balances.find(b => b.publicKey === accounts[0]!.public_key)?.balanceXlm).toBe(100.5);
            expect(balances.find(b => b.publicKey === accounts[1]!.public_key)?.balanceXlm).toBe(50.25);
        });

        it("reports null balance for accounts with no known balance", () => {
            seedAccounts(db, 1);
            const pool = new ChannelAccountPool(db, "testnet");
            const balances = pool.getBalances();
            expect(balances[0]!.balanceXlm).toBeNull();
        });

        it("refreshes balances from the RPC and persists to DB", async () => {
            const accounts = seedAccounts(db, 2);
            mockGetAccount.mockResolvedValue({ balances: [{ asset_type: "native", balance: "75.0000000" }] });

            const pool = new ChannelAccountPool(db, "testnet");
            await pool.refreshBalances();

            const stored = getChannelAccounts(db, "testnet");
            for (const acc of stored) {
                expect(acc.balance_xlm).toBe(75);
                expect(acc.balance_checked_at).not.toBeNull();
            }

            expect(mockGetAccount).toHaveBeenCalledTimes(accounts.length);
        });

        it("handles RPC failure gracefully during balance refresh", async () => {
            seedAccounts(db, 2);
            mockGetAccount.mockRejectedValue(new Error("RPC unavailable"));

            const pool = new ChannelAccountPool(db, "testnet");
            // Should not throw
            await expect(pool.refreshBalances()).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // 5. Repository functions
    // =========================================================================
    describe("repository", () => {
        it("upsertChannelAccount inserts and updates without duplicate", () => {
            const acc = { public_key: "GPUBKEY1" + "A".repeat(49), keypair_source: "env:KEY1", network: "testnet" };
            upsertChannelAccount(db, acc);
            upsertChannelAccount(db, { ...acc, keypair_source: "env:KEY2" });
            const stored = getChannelAccounts(db, "testnet");
            expect(stored).toHaveLength(1);
            expect(stored[0]!.keypair_source).toBe("env:KEY2");
        });

        it("deleteChannelAccount removes the account", () => {
            const accounts = seedAccounts(db, 2);
            deleteChannelAccount(db, accounts[0]!.public_key);
            const stored = getChannelAccounts(db, "testnet");
            expect(stored).toHaveLength(1);
            expect(stored[0]!.public_key).toBe(accounts[1]!.public_key);
        });

        it("updateChannelBalance updates balance and timestamp", () => {
            const accounts = seedAccounts(db, 1);
            updateChannelBalance(db, accounts[0]!.public_key, 42.5);
            const stored = getChannelAccounts(db, "testnet");
            expect(stored[0]!.balance_xlm).toBe(42.5);
            expect(stored[0]!.balance_checked_at).not.toBeNull();
        });

        it("getChannelAccounts filters by network", () => {
            seedAccounts(db, 2, "testnet");
            seedAccounts(db, 1, "mainnet");
            const testnet = getChannelAccounts(db, "testnet");
            const mainnet = getChannelAccounts(db, "mainnet");
            expect(testnet).toHaveLength(2);
            expect(mainnet).toHaveLength(1);
        });
    });
});
