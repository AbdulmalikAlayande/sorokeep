import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as repositories from "../../src/db/repositories";
import { registerPauseCommand } from "../../src/commands/pause";
import { registerResumeCommand } from "../../src/commands/resume";

vi.mock("../../src/db/database");
vi.mock("../../src/db/repositories");

describe("Pause and Resume Commands", () => {
    let program: Command;
    let mockExit: any;
    let mockLog: any;
    let pauseActionFn: (contractId: string) => Promise<void>;
    let resumeActionFn: (contractId: string) => Promise<void>;

    beforeEach(() => {
        program = new Command();
        
        vi.spyOn(Command.prototype, "action").mockImplementation(function (
            this: any,
            fn: any,
        ) {
            if (this.name() === "pause") pauseActionFn = fn;
            if (this.name() === "resume") resumeActionFn = fn;
            return this;
        });

        registerPauseCommand(program);
        registerResumeCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(dbLib, "getDatabase").mockReturnValue({ close: vi.fn() } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("pause exits with 1 if contract is not found", async () => {
        vi.mocked(repositories.getContract).mockReturnValue(undefined);
        await pauseActionFn("CDEF1234");
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("pause calls setContractActiveStatus with false", async () => {
        vi.mocked(repositories.getContract).mockReturnValue({ id: "CDEF1234" } as any);
        await pauseActionFn("CDEF1234");
        expect(repositories.setContractActiveStatus).toHaveBeenCalledWith(expect.anything(), "CDEF1234", false);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Successfully paused"));
    });

    it("resume exits with 1 if contract is not found", async () => {
        vi.mocked(repositories.getContract).mockReturnValue(undefined);
        await resumeActionFn("CDEF1234");
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("resume calls setContractActiveStatus with true", async () => {
        vi.mocked(repositories.getContract).mockReturnValue({ id: "CDEF1234" } as any);
        await resumeActionFn("CDEF1234");
        expect(repositories.setContractActiveStatus).toHaveBeenCalledWith(expect.anything(), "CDEF1234", true);
        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Successfully resumed"));
    });
});
