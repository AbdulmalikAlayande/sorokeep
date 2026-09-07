/**
 * Tests for issue #428: zero out channel account secret keys from memory after use.
 *
 * These tests verify that:
 * 1. zeroizeKeypair() zeroes the Buffer backing the Stellar Keypair's raw secret key.
 * 2. Signing works correctly before zeroing — no functional regression.
 * 3. After zeroing, the buffer is all zeros (the mitigation is observable).
 * 4. fundChannels() zeroes the keypair it creates locally after the payment is sent.
 *
 * What this does and does NOT guarantee
 * ──────────────────────────────────────
 * Zeroing the rawSecretKey() Buffer removes the key material from the Keypair
 * object's memory backing. However, because JavaScript strings are immutable
 * and interned by V8, the original secret-key string (e.g. the "S…" stroop)
 * may persist elsewhere in the heap until GC collects it. This is defense-in-depth,
 * not a hard guarantee of secure erasure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertChannelAccount } from "../../src/db/repositories.js";

// ─── Mock RPC client ─────────────────────────────────────────────────────────

const mockSendPayments = vi.fn();
vi.mock("../../src/rpc/client.js", () => ({
    StellarRpcClient: class {
        sendPayments = mockSendPayments;
    },
}));

// Dynamic import after mock registration
const { zeroizeKeypair, fundChannels } = await import("../../src/core/channels.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a valid Stellar test secret key. */
function makeTestKeypair(): Keypair {
    return Keypair.random();
}

/** Seed a single channel account into the test DB. */
function seedChannel(db: Database.Database, network = "testnet"): string {
    const suffix = "A".repeat(50);
    const public_key = `G${suffix}`.slice(0, 56);
    insertChannelAccount(db, { public_key, network, label: "test" });
    return public_key;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("zeroizeKeypair()", () => {
    it("zeroes the rawSecretKey buffer — all bytes become 0x00", () => {
        const keypair = makeTestKeypair();
        const rawBefore = keypair.rawSecretKey();

        // Confirm the key is not already all zeros before the test
        expect(rawBefore.some(b => b !== 0)).toBe(true);

        zeroizeKeypair(keypair);

        // rawSecretKey() returns the same underlying ArrayBuffer,
        // so it should now be all zeros.
        const rawAfter = keypair.rawSecretKey();
        expect(rawAfter.every(b => b === 0)).toBe(true);
    });

    it("does not throw when called on a freshly constructed Keypair", () => {
        const keypair = makeTestKeypair();
        expect(() => zeroizeKeypair(keypair)).not.toThrow();
    });

    it("is idempotent — calling it twice does not throw", () => {
        const keypair = makeTestKeypair();
        zeroizeKeypair(keypair);
        expect(() => zeroizeKeypair(keypair)).not.toThrow();
        expect(keypair.rawSecretKey().every(b => b === 0)).toBe(true);
    });

    it("zeroing one Keypair does not affect a different Keypair instance", () => {
        const kp1 = makeTestKeypair();
        const kp2 = makeTestKeypair();

        const kp2RawBefore = kp2.rawSecretKey().slice(); // take a copy before zeroing kp1
        zeroizeKeypair(kp1);

        // kp2's raw secret should be unchanged
        const kp2RawAfter = kp2.rawSecretKey();
        expect(Array.from(kp2RawAfter)).toEqual(Array.from(kp2RawBefore));
    });

    // Functional-regression guard: signing must still work BEFORE zeroing.
    it("keypair can sign a message before zeroing (no functional regression)", () => {
        const keypair = makeTestKeypair();
        const message = Buffer.from("sorokeep-test-payload");

        let signature: Buffer;
        expect(() => {
            signature = keypair.sign(message);
        }).not.toThrow();

        // Signature is 64 bytes (ed25519)
        expect(signature!.length).toBe(64);

        // Signature verifies correctly
        expect(keypair.verify(message, signature!)).toBe(true);

        // Now zero the key — this is where zeroing happens in production
        zeroizeKeypair(keypair);

        // The buffer is now all zeros
        expect(keypair.rawSecretKey().every(b => b === 0)).toBe(true);
    });
});

describe("fundChannels() key zeroing", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    afterEach(() => {
        // Ensure any vi.spyOn calls within this suite are fully restored so they
        // don't leak into other test files (e.g. budget_enforcement.test.ts,
        // which mocks @stellar/stellar-sdk and would be broken by a lingering spy).
        vi.restoreAllMocks();
    });

    it("calls sendPayments and returns funded count on success", async () => {
        seedChannel(db);
        const masterKeypair = makeTestKeypair();
        const masterSecret = masterKeypair.secret();

        mockSendPayments.mockResolvedValue({
            success: true,
            txHash: "abc123",
            ledger: 100,
        });

        const result = await fundChannels(db, masterSecret, "10", "testnet");

        expect(result.funded).toBe(1);
        expect(result.txHash).toBe("abc123");
        expect(result.errors).toEqual([]);
        expect(mockSendPayments).toHaveBeenCalledOnce();
    });

    it("returns errors when sendPayments fails", async () => {
        seedChannel(db);
        const masterKeypair = makeTestKeypair();
        const masterSecret = masterKeypair.secret();

        mockSendPayments.mockResolvedValue({
            success: false,
            txHash: "fail123",
            ledger: 0,
            error: "Insufficient balance",
        });

        const result = await fundChannels(db, masterSecret, "10", "testnet");

        expect(result.funded).toBe(0);
        expect(result.errors).toContain("Insufficient balance");
    });

    it("returns early with zero funded when no channels registered", async () => {
        const masterKeypair = makeTestKeypair();
        const masterSecret = masterKeypair.secret();

        const result = await fundChannels(db, masterSecret, "10", "testnet");

        expect(result.funded).toBe(0);
        expect(result.txHash).toBe("");
        expect(mockSendPayments).not.toHaveBeenCalled();
    });

    it("zeroes the local Keypair buffer even when sendPayments succeeds", async () => {
        seedChannel(db);

        // We spy on Keypair.fromSecret to capture the created keypair instance
        const createdKeypairs: Keypair[] = [];
        const originalFromSecret = Keypair.fromSecret.bind(Keypair);
        vi.spyOn(Keypair, "fromSecret").mockImplementation((secret: string) => {
            const kp = originalFromSecret(secret);
            createdKeypairs.push(kp);
            return kp;
        });

        mockSendPayments.mockResolvedValue({
            success: true,
            txHash: "abc456",
            ledger: 101,
        });

        const masterKeypair = makeTestKeypair();
        await fundChannels(db, masterKeypair.secret(), "10", "testnet");

        // At least one Keypair was created and its buffer should now be zeroed
        expect(createdKeypairs.length).toBeGreaterThan(0);
        for (const kp of createdKeypairs) {
            expect(kp.rawSecretKey().every(b => b === 0)).toBe(true);
        }

        vi.restoreAllMocks();
    });

    it("zeroes the local Keypair buffer even when sendPayments throws", async () => {
        seedChannel(db);

        const createdKeypairs: Keypair[] = [];
        const originalFromSecret = Keypair.fromSecret.bind(Keypair);
        vi.spyOn(Keypair, "fromSecret").mockImplementation((secret: string) => {
            const kp = originalFromSecret(secret);
            createdKeypairs.push(kp);
            return kp;
        });

        mockSendPayments.mockRejectedValue(new Error("RPC unreachable"));

        const masterKeypair = makeTestKeypair();
        await expect(
            fundChannels(db, masterKeypair.secret(), "10", "testnet")
        ).rejects.toThrow("RPC unreachable");

        // Buffer should still be zeroed even when an error is thrown
        expect(createdKeypairs.length).toBeGreaterThan(0);
        for (const kp of createdKeypairs) {
            expect(kp.rawSecretKey().every(b => b === 0)).toBe(true);
        }

        vi.restoreAllMocks();
    });
});
