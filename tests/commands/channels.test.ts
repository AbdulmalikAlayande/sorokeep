import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerChannelsCommand } from "../../src/commands/channels";
import { getChannelAccounts, insertChannelAccount } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return { ...actual, getDatabase: () => mockDb };
});

// Mock fundChannels so fund tests don't hit the network
vi.mock("../../src/core/channels.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        fundChannels: vi.fn(),
    };
});

describe("channels command", () => {
    const MASTER_KEY = "SCZANGBA5AKIA5OSBZPZU5KA5BWNNASCTLZ5I3XUGP7ZXFJEFZ4MFLN";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        vi.clearAllMocks();
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called");
        }) as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── channels add ────────────────────────────────────────────────────────

    describe("channels add", () => {
        it("registers a channel account key", () => {
            const program = new Command();
            registerChannelsCommand(program);

            program.parse([
                "node", "sorokeep",
                "channels", "add",
                "--key", "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                "--network", "testnet",
            ]);

            const accounts = getChannelAccounts(mockDb, "testnet");
            expect(accounts).toHaveLength(1);
            expect(accounts[0]).toMatchObject({
                public_key: "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                network: "testnet",
                funded: 0,
            });
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("registered")
            );
        });

        it("registers a channel account with an optional label", () => {
            const program = new Command();
            registerChannelsCommand(program);

            program.parse([
                "node", "sorokeep",
                "channels", "add",
                "--key", "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                "--label", "fee-bumper-1",
                "--network", "testnet",
            ]);

            const accounts = getChannelAccounts(mockDb, "testnet");
            expect(accounts[0]!.label).toBe("fee-bumper-1");
        });

        it("rejects duplicate public keys", () => {
            insertChannelAccount(mockDb, {
                public_key: "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                network: "testnet",
            });

            const program = new Command();
            registerChannelsCommand(program);

            expect(() => {
                program.parse([
                    "node", "sorokeep",
                    "channels", "add",
                    "--key", "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                    "--network", "testnet",
                ]);
            }).toThrow("process.exit called");

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("already registered")
            );
        });
    });

    // ── channels list ───────────────────────────────────────────────────────

    describe("channels list", () => {
        it("lists registered channel accounts", () => {
            insertChannelAccount(mockDb, {
                public_key: "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5",
                label: "ch-1",
                network: "testnet",
            });

            const program = new Command();
            registerChannelsCommand(program);

            program.parse(["node", "sorokeep", "channels", "list", "--network", "testnet"]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5")
            );
        });

        it("shows a message when no accounts are registered", () => {
            const program = new Command();
            registerChannelsCommand(program);

            program.parse(["node", "sorokeep", "channels", "list", "--network", "testnet"]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("No channel accounts")
            );
        });
    });

    // ── channels fund ───────────────────────────────────────────────────────

    describe("channels fund", () => {
        it("calls fundChannels and reports success", async () => {
            const { fundChannels } = await import("../../src/core/channels.js");
            (fundChannels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                funded: 2,
                txHash: "abc123",
                errors: [],
            });

            insertChannelAccount(mockDb, { public_key: "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5", network: "testnet" });
            insertChannelAccount(mockDb, { public_key: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6", network: "testnet" });

            const program = new Command();
            registerChannelsCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "channels", "fund",
                "--master-key", MASTER_KEY,
                "--amount", "10",
                "--network", "testnet",
            ]);

            expect(fundChannels).toHaveBeenCalledWith(
                expect.anything(),        // db
                MASTER_KEY,
                "10",
                "testnet",
                undefined,               // rpcUrl
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("2")
            );
        });

        it("reports errors from fundChannels", async () => {
            const { fundChannels } = await import("../../src/core/channels.js");
            (fundChannels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                funded: 0,
                txHash: "",
                errors: ["Insufficient balance"],
            });

            // Need at least one account so the guard doesn't block
            insertChannelAccount(mockDb, { public_key: "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH85FYDNE5VRLJQJN5", network: "testnet" });

            const program = new Command();
            registerChannelsCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "channels", "fund",
                "--master-key", MASTER_KEY,
                "--amount", "10",
                "--network", "testnet",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Insufficient balance")
            );
        });

        it("exits if no channel accounts are registered", async () => {
            const { fundChannels } = await import("../../src/core/channels.js");

            const program = new Command();
            registerChannelsCommand(program);

            await expect(
                program.parseAsync([
                    "node", "sorokeep",
                    "channels", "fund",
                    "--master-key", MASTER_KEY,
                    "--amount", "10",
                    "--network", "testnet",
                ])
            ).rejects.toThrow("process.exit called");

            expect(fundChannels).not.toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("No channel accounts")
            );
        });
    });
});
