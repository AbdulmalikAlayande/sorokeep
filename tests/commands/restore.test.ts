import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerRestoreCommand } from "../../src/commands/restore";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as repos from "../../src/db/repositories";
import * as extensionLib from "../../src/core/extension";

vi.mock("../../src/db/database");
vi.mock("../../src/db/repositories");
vi.mock("../../src/core/extension");

describe("Restore Command CLI", () => {
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

        registerRestoreCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exits with 1 if contract is not found", async () => {
        vi.mocked(repos.getContract).mockReturnValue(undefined as any);

        await actionFn("MISSING_ID", {});
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("exits with 1 if no keypair provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", {});
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("--keypair or --keypair-env is required"));
    });

    it("exits with 1 if --keypair-env points to unset env var", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        delete process.env["NONEXISTENT_VAR_FOR_TEST"];

        await actionFn("VALID_ID", { keypairEnv: "NONEXISTENT_VAR_FOR_TEST" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("is not set"));
    });

    it("exits with 1 if both --entry and --all are provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { keypair: "SKEY", all: true, entry: ["AAAA"] });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Use either --entry"));
    });

    it("exits with 1 if neither --entry nor --all is provided", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", { keypair: "SKEY", entry: [] });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Specify --entry"));
    });

    it("prints 'No entries to restore' when --all but contract has no entries", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([]);

        await actionFn("VALID_ID", { keypair: "SKEY", all: true });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No entries to restore"));
    });

    it("restores entries successfully with --all and outputs tx hash and fee", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet", name: "MyContract" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([
            { entry_key_xdr: "AAAA" } as any,
        ]);
        vi.mocked(extensionLib.restoreEntries).mockResolvedValue({
            success: true,
            entriesRestored: 1,
            txHash: "abcd1234",
            ledger: 5000,
            feeCharged: 500,
        } as any);

        await actionFn("VALID_ID", { keypair: "SKEY", all: true });
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("abcd1234"));
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("500 stroops"));
    });

    it("exits with 1 when restore fails", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getEntriesForContract).mockReturnValue([
            { entry_key_xdr: "AAAA" } as any,
        ]);
        vi.mocked(extensionLib.restoreEntries).mockResolvedValue({
            success: false,
            error: "Insufficient funds",
        } as any);

        await actionFn("VALID_ID", { keypair: "SKEY", all: true });
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("restores specific entries with --entry", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(extensionLib.restoreEntries).mockResolvedValue({
            success: true,
            entriesRestored: 2,
            txHash: "efgh5678",
            ledger: 6000,
        } as any);

        await actionFn("VALID_ID", { keypair: "SKEY", entry: ["KEY1", "KEY2"] });
        expect(extensionLib.restoreEntries).toHaveBeenCalledWith(
            expect.anything(),
            "VALID_ID",
            ["KEY1", "KEY2"],
            "SKEY"
        );
    });
});
