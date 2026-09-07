import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";
import { Keypair } from "@stellar/stellar-sdk";
import type Database from "better-sqlite3";

import { createLogger } from "../../src/logging/logger.js";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    upsertChannelAccount,
    updateChannelBalance,
} from "../../src/db/repositories.js";
import {
    extendEntries,
    restoreEntries,
    resolveSecretKey,
    runAutoExtensions,
} from "../../src/core/extension.js";
import { ChannelAccountPool, fundChannels } from "../../src/core/channels.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────
//
// The StellarRpcClient module is replaced so the RPC-facing code paths
// (extension, restore, channel funding) never touch the network. Each method
// is a hoisted vi.fn so the individual scenarios can drive success / failure
// returns independently. RPC mocks are *not* logger mocks — every log line in
// those paths still flows through the real pino sink captured below.
const rpc = vi.hoisted(() => {
    const mk = () => vi.fn();
    const fns: Record<string, ReturnType<typeof vi.fn>> = {
        submitExtension: mk(),
        submitRestore: mk(),
        submitExtensionWithFeeBump: mk(),
        getEntryTTLs: mk(),
        getCurrentLedger: mk(),
        simulateExtension: mk(),
        simulateRestore: mk(),
        sendPayments: mk(),
    };
    return {
        fns,
        reset() {
            for (const f of Object.values(fns)) f.mockReset();
        },
    };
});

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        constructor() {}
        submitExtension = rpc.fns.submitExtension;
        submitRestore = rpc.fns.submitRestore;
        submitExtensionWithFeeBump = rpc.fns.submitExtensionWithFeeBump;
        getEntryTTLs = rpc.fns.getEntryTTLs;
        getCurrentLedger = rpc.fns.getCurrentLedger;
        simulateExtension = rpc.fns.simulateExtension;
        simulateRestore = rpc.fns.simulateRestore;
        sendPayments = rpc.fns.sendPayments;
    }
    return { StellarRpcClient: MockStellarRpcClient };
});

// Hold a real, captured pino logger that the mocked `getLogger()` delegates to.
// The delegation is dynamic (looked up at each call), so any module that bound
// `const logger = getLogger().child(...)` at import time still writes to the
// *current* capture sink. Nothing is excluded: every logger call in the
// exercised code paths goes through real pino into the in-memory stream.
const logState = vi.hoisted(() => ({
    holder: undefined as unknown,
    lines: [] as string[],
}));

vi.mock("../../src/logging/index", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    const delegating = (): any => {
        const wrapper = {
            child: () => delegating(),
            debug: (...a: unknown[]) => (logState.holder as any)?.debug?.(...a),
            info: (...a: unknown[]) => (logState.holder as any)?.info?.(...a),
            warn: (...a: unknown[]) => (logState.holder as any)?.warn?.(...a),
            error: (...a: unknown[]) => (logState.holder as any)?.error?.(...a),
            fatal: (...a: unknown[]) => (logState.holder as any)?.fatal?.(...a),
        };
        return wrapper;
    };
    return {
        ...actual,
        getLogger: delegating,
        initLogger: delegating,
        configureLogger: delegating,
    };
});

// ─── Capture harness ──────────────────────────────────────────────────────────
//
// Build a fresh JSON-format pino logger for the requested log level whose
// destination is an in-memory Writable. Every line the real logger emits (at
// or above `level`) is collected so we can assert on the raw emitted output.
let capturedLines: string[] = [];

function configureCapture(level: string): void {
    capturedLines = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            for (const line of chunk.toString().split("\n")) {
                if (line.trim()) capturedLines.push(line);
            }
            cb();
        },
    });
    logState.holder = createLogger({
        level: level as never,
        prettyPrint: false,
        format: "json",
        destination: stream,
    });
    logState.lines = capturedLines;
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CHANNEL_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";
const ENTRY_XDR = "instance-key-xdr";

// A genuine Stellar secret key with a valid checksum (created by the SDK), used
// as the poisoned value we expect NEVER to leak into any log line.
const SECRET = Keypair.random().secret();

// Full-strength secret-key shape as defined in SECURITY.md.
const SECRET_KEY_RE = /S[A-Z0-9]{55}/;

function makeDb(): Database.Database {
    const db = getDatabaseForTesting();
    insertContract(db, {
        id: CONTRACT_ID,
        name: "Security Test Contract",
        network: "testnet",
    });
    upsertEntry(db, {
        contract_id: CONTRACT_ID,
        entry_key_xdr: ENTRY_XDR,
        entry_type: "instance",
        live_until_ledger: 2410000,
        discovery_source: "deterministic",
    });
    return db;
}

/** Assert the negative: no captured line leaks the secret in any form. */
function assertNoSecretLeak(secret: string): void {
    // Partial-leak guard: catch anything that accidentally logs a usable prefix
    // of the secret, not just the full 56-char value.
    const partialPrefix = secret.slice(0, 8);

    for (const line of capturedLines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(partialPrefix);
        expect(line).not.toMatch(SECRET_KEY_RE);
    }
}

// ─── Secret-touching code paths ───────────────────────────────────────────────

async function runGuardKeypairPaths(): Promise<void> {
    // guard --keypair <secret>: direct resolution must not log the value.
    const resolved = await resolveSecretKey(SECRET);
    expect(resolved).toBe(SECRET);

    // Corrupted secret-shaped source exercises the `formatSecretKey` redaction
    // path in resolveSecretKey's fallback warning.
    await resolveSecretKey(`${SECRET}-corrupted`);

    // Missing env var path (guard --keypair-env) logs a warning.
    await resolveSecretKey("env:SOROKEEP_MISSING_TEST_VAR");

    // guard --auto-extend --keypair-env failure path.
    await resolveSecretKey("vault:secret/data/stellar/missing");
}

async function runRestoreKeypairPaths(): Promise<void> {
    // restore --keypair <secret> success path logs info messages.
    const db = makeDb();
    rpc.fns.submitRestore.mockResolvedValue({
        success: true,
        txHash: "restore-ok",
        ledger: 2400500,
    });
    rpc.fns.getEntryTTLs.mockResolvedValue({
        latestLedger: 2400500,
        entries: [
            {
                entryKeyXdr: ENTRY_XDR,
                latestLedger: 2400500,
                liveUntilLedgerSeq: 2500500,
                lastModifiedLedgerSeq: 2400500,
                remainingTTL: 100000,
            },
        ],
    });
    const ok = await restoreEntries(db, CONTRACT_ID, [ENTRY_XDR], SECRET);
    expect(ok.success).toBe(true);

    // Failure path logs an error.
    const db2 = makeDb();
    rpc.fns.submitRestore.mockResolvedValue({
        success: false,
        txHash: "restore-fail",
        ledger: 0,
        error: "Entry not found in archive",
    });
    const failed = await restoreEntries(db2, CONTRACT_ID, [ENTRY_XDR], SECRET);
    expect(failed.success).toBe(false);

    // Throwing path logs a warning.
    const db3 = makeDb();
    rpc.fns.submitRestore.mockRejectedValue(new Error("restore network error"));
    const thrown = await restoreEntries(db3, CONTRACT_ID, [ENTRY_XDR], SECRET);
    expect(thrown.success).toBe(false);
}

async function runExtensionKeypairPaths(): Promise<void> {
    // guard manual-extend / daemon auto-extension success logs info.
    const db = makeDb();
    rpc.fns.submitExtension.mockResolvedValue({
        success: true,
        txHash: "extend-ok",
        ledger: 2400100,
    });
    rpc.fns.getEntryTTLs.mockResolvedValue({
        latestLedger: 2400100,
        entries: [
            {
                entryKeyXdr: ENTRY_XDR,
                latestLedger: 2400100,
                liveUntilLedgerSeq: 2500100,
                lastModifiedLedgerSeq: 2400100,
                remainingTTL: 100000,
            },
        ],
    });
    const ok = await extendEntries(db, CONTRACT_ID, [ENTRY_XDR], 100000, SECRET);
    expect(ok.success).toBe(true);

    // Failure path logs an error.
    const db2 = makeDb();
    rpc.fns.submitExtension.mockResolvedValue({
        success: false,
        txHash: "extend-fail",
        ledger: 0,
        error: "Transaction send error: Insufficient funds",
    });
    const failed = await extendEntries(db2, CONTRACT_ID, [ENTRY_XDR], 100000, SECRET);
    expect(failed.success).toBe(false);

    // Throwing path logs a warning.
    const db3 = makeDb();
    rpc.fns.submitExtension.mockRejectedValue(new Error("extension network error"));
    const thrown = await extendEntries(db3, CONTRACT_ID, [ENTRY_XDR], 100000, SECRET);
    expect(thrown.success).toBe(false);
}

async function runChannelKeypairPaths(): Promise<void> {
    // A channel account whose keypair_source is the raw secret: acquire() hands
    // the secret through the pool, and fundChannels() spends the master secret.
    const db = makeDb();
    upsertChannelAccount(db, {
        public_key: CHANNEL_PUBKEY,
        network: "testnet",
        keypair_source: SECRET,
    });

    const pool = new ChannelAccountPool(db, "testnet");
    const slot = await pool.acquire();
    expect(slot.keypairSource).toBe(SECRET);
    const resolved = await resolveSecretKey(slot.keypairSource!);
    expect(resolved).toBe(SECRET);
    pool.release(CHANNEL_PUBKEY);

    // fundChannels success path spends the master secret.
    rpc.fns.sendPayments.mockResolvedValue({
        success: true,
        txHash: "fund-ok",
        ledger: 2400600,
    });
    const funded = await fundChannels(db, SECRET, "10", "testnet");
    expect(funded.funded).toBe(1);

    // fundChannels failure path.
    rpc.fns.sendPayments.mockResolvedValue({
        success: false,
        txHash: "",
        ledger: 0,
        error: "Transaction send error: Insufficient funds",
    });
    const failedFund = await fundChannels(db, SECRET, "10", "testnet");
    expect(failedFund.funded).toBe(0);
}

async function runAutoExtensionThroughChannelPool(): Promise<void> {
    // Auto-extension resolving the keypair from a channel account pool whose
    // keypair_source holds the raw secret (guard --auto-extend + channels).
    const db = getDatabaseForTesting();
    insertContract(db, {
        id: CONTRACT_ID,
        name: "Auto Extend Sec",
        network: "testnet",
    });
    upsertEntry(db, {
        contract_id: CONTRACT_ID,
        entry_key_xdr: ENTRY_XDR,
        entry_type: "instance",
        live_until_ledger: 2410000,
        discovery_source: "deterministic",
    });
    upsertExtensionPolicy(db, {
        contract_id: CONTRACT_ID,
        enabled: true,
        target_ttl_ledgers: 100000,
        extend_when_below_ledgers: 20000,
        keypair_source: `env:IGNORED_FALLBACK`,
    });
    upsertChannelAccount(db, {
        public_key: CHANNEL_PUBKEY,
        network: "testnet",
        keypair_source: SECRET,
    });
    // Required since issue #504's minimum-balance safety check: a channel
    // account with an unknown (never-checked) balance is now skipped rather
    // than attempted, so this fixture must report a sufficient balance.
    updateChannelBalance(db, CHANNEL_PUBKEY, 100);

    rpc.fns.getCurrentLedger.mockResolvedValue(2400000);
    rpc.fns.submitExtension.mockResolvedValue({
        success: true,
        txHash: "auto-extend-ok",
        ledger: 2400100,
    });
    rpc.fns.getEntryTTLs.mockResolvedValue({
        latestLedger: 2400100,
        entries: [
            {
                entryKeyXdr: ENTRY_XDR,
                latestLedger: 2400100,
                liveUntilLedgerSeq: 2500100,
                lastModifiedLedgerSeq: 2400100,
                remainingTTL: 100000,
            },
        ],
    });

    const result = await runAutoExtensions(db, "testnet");
    expect(result.contractsExtended).toBe(1);
}

// The log levels sorokeep's Logger wrapper exposes. Every secret-touching path
// is run with pino configured to each threshold; because pino at a low level
// emits all higher severities, running at "debug" catches leaks surfacing at
// any severity, and the higher-level runs guard against level-specific hacks.
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SECURITY: no secret key ever appears in log output", () => {
    beforeEach(() => {
        rpc.reset();
        rpc.fns.getCurrentLedger.mockResolvedValue(2400000);
        rpc.fns.getEntryTTLs.mockResolvedValue({ latestLedger: 2400000, entries: [] });
        rpc.fns.submitExtension.mockResolvedValue({
            success: true,
            txHash: "default-tx",
            ledger: 2400100,
        });
        rpc.fns.submitRestore.mockResolvedValue({
            success: true,
            txHash: "default-restore",
            ledger: 2400500,
        });
        rpc.fns.sendPayments.mockResolvedValue({
            success: true,
            txHash: "default-fund",
            ledger: 2400600,
        });
    });

    it.each(LOG_LEVELS)(
        "captures log output at level '%s' and never leaks the secret key",
        async (level) => {
            configureCapture(level);

            await runGuardKeypairPaths();
            await runRestoreKeypairPaths();
            await runExtensionKeypairPaths();
            await runChannelKeypairPaths();
            await runAutoExtensionThroughChannelPool();

            // Sanity: the capture harness actually received log lines from the
            // real pino sink at this level. If this is ever empty, the test is
            // not asserting anything and should be fixed.
            expect(capturedLines.length).toBeGreaterThan(0);

            assertNoSecretLeak(SECRET);
        },
    );

    it("sanity: the capture harness sees JSON log lines containing the emitted messages", () => {
        configureCapture("debug");
        // Direct drive of the captured logger to prove non-empty, real output.
        (logState.holder as any).info("capture-probe-message");
        const joined = capturedLines.join("\n");
        expect(joined).toContain("capture-probe-message");
        expect(joined).toContain('"level":"info"');
    });
});