import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerDaemonCommand } from "../../src/commands/daemon";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as daemonLib from "../../src/daemon/loop";

vi.mock("../../src/db/database");
vi.mock("../../src/daemon/loop");

function getDaemonCommand(): Command {
    const program = new Command();
    registerDaemonCommand(program);
    const daemon = program.commands.find((c) => c.name() === "daemon");
    expect(daemon).toBeDefined();
    return daemon!;
}

describe("daemon command --log-format option", () => {
    it("registers a --log-format option", () => {
        const opt = getDaemonCommand().options.find((o) => o.long === "--log-format");
        expect(opt).toBeDefined();
    });

    it("defaults the log format to 'pretty'", () => {
        const opt = getDaemonCommand().options.find((o) => o.long === "--log-format");
        expect(opt!.defaultValue).toBe("pretty");
    });

    it("documents that json is a supported value", () => {
        const opt = getDaemonCommand().options.find((o) => o.long === "--log-format");
        expect(opt!.description.toLowerCase()).toContain("json");
    });
});

describe("Daemon Command CLI", () => {
    let program: Command;
    let mockExit: any;
    let mockLog: any;
    let actionFn: (options: any) => Promise<void>;

    beforeEach(() => {
        program = new Command();
        
        vi.spyOn(Command.prototype, "action").mockImplementation(function(this: any, fn: any) {
            actionFn = fn;
            return this;
        });
        
        registerDaemonCommand(program);
        
        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({ close: vi.fn() } as any);
        vi.spyOn(daemonLib, "startDaemon").mockImplementation(async () => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exits with code 1 if interval is less than 10000", async () => {
        await actionFn({ network: "testnet", interval: "9999" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("--interval must be a number"));
    });

    it("exits with code 1 if interval is not a number", async () => {
        await actionFn({ network: "testnet", interval: "abc" });
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("exits with code 1 if database fails to open", async () => {
        vi.spyOn(dbLib, "getDatabase").mockImplementation(() => {
            throw new Error("DB Error");
        });
        await actionFn({ network: "testnet", interval: "10000" });
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Failed to open database"));
    });

    it("starts the daemon loop with correct options", async () => {
        await actionFn({ network: "mainnet", interval: "300000", rpcUrl: "https://my-rpc.com" });
        
        expect(daemonLib.startDaemon).toHaveBeenCalledWith(
            expect.anything(),
            "mainnet",
            expect.objectContaining({
                intervalMs: 300000,
                rpcUrl: "https://my-rpc.com"
            })
        );
    });   
});
