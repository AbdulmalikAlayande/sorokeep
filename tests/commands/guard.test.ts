import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGuardCommand } from "../../src/commands/guard";
import { Command } from "commander";
import * as repos from "../../src/db/repositories";
import * as extensionLib from "../../src/core/extension";
import ora from "ora";

const { mockSpinner } = vi.hoisted(() => {
    return {
        mockSpinner: {
            start: vi.fn().mockReturnThis(),
            succeed: vi.fn().mockReturnThis(),
            fail: vi.fn().mockReturnThis(),
        },
    };
});

vi.mock("ora", () => ({
    default: vi.fn(() => mockSpinner),
}));

import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, getExtensionPolicy } from "../../src/db/repositories";

// A genuine Stellar secret key used across all tests (safe — only for testing)
const VALID_TEST_SECRET = "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG";
const VALID_TEST_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";

// Shared DB reference — set in each beforeEach so both suites control it
let sharedDb: ReturnType<typeof getDatabaseForTesting>;

vi.mock("../../src/db/database", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => sharedDb,
    };
});

vi.mock("../../src/core/extension", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        simulateExtension: vi.fn(),
        extendEntries: vi.fn(),
        resolveSecretKey: vi.fn(async (source: string) => {
            if (source.startsWith("env:") || source.startsWith("vault:")) {
                return VALID_TEST_SECRET;
            }
            return source;
        }),
    };
});

// ─── Unit tests ────────────────────────────────────────────────────────────

describe("Guard Command CLI", () => {
    let actionFn: (contractId: string, options: any) => Promise<void>;
    let mockExit: any;
    let mockError: any;
    let mockLog: any;

    beforeEach(() => {
        sharedDb = getDatabaseForTesting();

        const program = new Command();
        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });
        registerGuardCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

        vi.spyOn(repos, "getContract");
        vi.spyOn(repos, "getEntriesForContract");
        vi.spyOn(repos, "upsertExtensionPolicy");
        vi.spyOn(repos, "getExtensionPolicy");
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("exits with code 1 if contract is not found in DB", async () => {
        vi.mocked(repos.getContract).mockReturnValue(undefined as any);

        await actionFn("MISSING_ID", { targetTtl: "100000", threshold: "20000" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("exits with code 1 if --target-ttl is not a positive number", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "abc", threshold: "20000" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--target-ttl must be a positive number"));
    });

    it("exits with code 1 if --threshold is not a positive number", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "abc" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--threshold must be a positive number"));
    });

    it("exits with code 1 if threshold >= targetTTL", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "100000" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--threshold must be less than --target-ttl"));
    });

    it("disables auto-extension when --disable is passed", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.upsertExtensionPolicy).mockImplementation(() => {});

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", disable: true });
        expect(repos.upsertExtensionPolicy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ contract_id: "VALID_ID", enabled: false })
        );
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    });

    it("requires --keypair-env for --auto-extend", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", autoExtend: true, keypair: "SKEY" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--auto-extend requires --keypair-env or --keypair-vault"));
    });

    it("shows no-policy message when no keypair or flags provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getExtensionPolicy).mockReturnValue(undefined as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No extension policy"));
    });

    it("displays existing policy when no keypair provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet", name: "MyContract" } as any);
        vi.mocked(repos.getExtensionPolicy).mockReturnValue({
            contract_id: "VALID_ID",
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
            keypair_public: "GABCDEF1234"
        } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("ENABLED"));
    });

    it("runs dry-run simulation when --dry-run is passed (handles Keypair import)", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([{ entry_key_xdr: "AAAA" } as any]);

        // Invalid key → Keypair.fromSecret throws → guard catches it and exits 1
        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true, keypair: "INVALID_KEY" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    });

    it("dry-run exits 1 if no keypair provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--keypair, --keypair-env, or --keypair-vault required"));
    });

    it("shows 'No entries to extend' for dry-run on contract with no entries", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([]);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true, keypair: "SCZZ" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No entries to extend"));
    });

    it("performs one-time manual extension when --keypair is provided without --dry-run or --auto-extend", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([{ entry_key_xdr: "AAAA" } as any]);
        vi.mocked(extensionLib.extendEntries).mockResolvedValue({
            success: true, entriesExtended: 1, txHash: "abcd1234", ledger: 5000
        } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", keypair: "SCZZ" });
        expect(extensionLib.extendEntries).toHaveBeenCalled();
    });

    it("displays resource limits during dry-run simulation", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockImplementation((db, id) => {
            return [{ entry_key_xdr: "AAAA" }];
        });
        vi.mocked(extensionLib.simulateExtension).mockImplementation(async () => ({
            success: true,
            entriesExtended: 1,
            estimatedFee: 100_000_000, // 10 XLM
            cpuInsns: 500,
            memBytes: 1024,
            readBytes: 2048,
            writeBytes: 3072
        } as any));

        // Use a valid looking secret key to avoid Keypair.fromSecret throwing
        const { Keypair } = await import("@stellar/stellar-sdk");
        const validSecret = Keypair.random().secret();
        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true, keypair: validSecret });
        
        expect(mockSpinner.succeed).toHaveBeenCalled();
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Entries:       1"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Estimated fee: 10.0000000 XLM"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("CPU:          500"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Memory:       1 KB"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Read size:    2 KB"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Write size:   3 KB"));
    });
});

// ─── Integration tests: acceptance criteria ────────────────────────────────
// Use a real in-memory SQLite DB (not mocked repos) to verify what is
// actually persisted when `--auto-extend` is used.

const TEST_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("Guard Command --auto-extend integration", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        sharedDb = getDatabaseForTesting();
        insertContract(sharedDb, {
            id: TEST_CONTRACT_ID,
            name: "Integration Test Contract",
            network: "testnet",
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("--auto-extend registers the extension policy in the database", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
            "--target-ttl", "100000",
            "--threshold", "20000",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();
        expect(policy!.enabled).toBeTruthy(); // SQLite stores booleans as 1/0
        expect(policy!.contract_id).toBe(TEST_CONTRACT_ID);
        expect(policy!.target_ttl_ledgers).toBe(100000);
        expect(policy!.extend_when_below_ledgers).toBe(20000);

        delete process.env.STELLAR_TEST_KEY;
    });

    it("only the public key (not the secret) is stored in the database after --auto-extend", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();

        // The public key is stored and matches the known public key for VALID_TEST_SECRET
        expect(policy!.keypair_public).toBe(VALID_TEST_PUBKEY);

        // The secret key itself must NOT appear anywhere in the stored row
        expect(policy!.keypair_public).not.toBe(VALID_TEST_SECRET);
        expect(policy!.keypair_source).not.toBe(VALID_TEST_SECRET);

        // keypair_source stores the env var reference, not the resolved secret
        expect(policy!.keypair_source).toBe("env:STELLAR_TEST_KEY");

        delete process.env.STELLAR_TEST_KEY;
    });
});
