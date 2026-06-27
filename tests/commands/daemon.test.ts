import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerDaemonCommand } from "../../src/commands/daemon";

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
