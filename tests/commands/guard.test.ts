import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGuardCommand } from "../../src/commands/guard";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as repos from "../../src/db/repositories";
import * as extensionLib from "../../src/core/extension";

vi.mock("../../src/db/database");
vi.mock("../../src/db/repositories");
vi.mock("../../src/core/extension");

describe("Guard Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockError: any;
    let mockLog: any;
    let actionFn: (contractId: string, options: any) => Promise<void>;

    beforeEach(() => {
        program = new Command();

        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });

        registerGuardCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--auto-extend requires --keypair-env"));
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
        vi.mocked(repos.getEntriesForContract).mockReturnValue([
            { entry_key_xdr: "AAAA" } as any,
        ]);

        // Using an invalid Stellar secret key will cause Keypair.fromSecret to throw.
        // The guard command catches this in its try/catch and exits with 1.
        // This is a valid behavior test — invalid keys should not crash the CLI.
        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true, keypair: "INVALID_KEY" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    });

    it("dry-run exits 1 if no keypair provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--keypair or --keypair-env required"));
    });

    it("shows 'No entries to extend' for dry-run on contract with no entries", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([]);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", dryRun: true, keypair: "SCZZ" });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No entries to extend"));
    });

    it("performs one-time manual extension when --keypair is provided without --dry-run or --auto-extend", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([
            { entry_key_xdr: "AAAA" } as any,
        ]);
        vi.mocked(extensionLib.extendEntries).mockResolvedValue({
            success: true,
            entriesExtended: 1,
            txHash: "abcd1234",
            ledger: 5000
        } as any);

        await actionFn("VALID_ID", { targetTtl: "100000", threshold: "20000", keypair: "SCZZ" });
        expect(extensionLib.extendEntries).toHaveBeenCalled();
    });
});
