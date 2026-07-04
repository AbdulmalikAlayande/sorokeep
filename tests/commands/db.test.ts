/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerDbCommand } from "../../src/commands/db";
import { Migrator } from "../../src/db/migrator";
import * as dbModule from "../../src/db/database";
import * as backupModule from "../../src/db/backup";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let mockDb: ReturnType<typeof getDatabaseForTesting>;


vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as typeof import("../../src/db/database.js");
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("db command", () => {
    let stdoutWriteSpy: any;
    let consoleLogSpy: any;
    let consoleErrorSpy: any;
    let exitSpy: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true as any);
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });


    afterEach(() => {
        mockDb.close();
        vi.restoreAllMocks();
    });

    it("db export outputs valid JSON", () => {
        vi.spyOn(backupModule, "exportDatabase").mockReturnValue({
            contracts: [{ id: "C1", network: "testnet" }],
            contract_entries: [],
            extension_policies: [],
            alert_configs: [],
            channel_accounts: [],
            resource_alert_configs: [],
        });

        const program = new Command();
        registerDbCommand(program);

        program.parse(["node", "sorokeep", "db", "export"]);

        const output = stdoutWriteSpy.mock.calls.map(([chunk]: [string]) => String(chunk)).join("");
        expect(() => JSON.parse(output)).not.toThrow();
        expect(JSON.parse(output)).toMatchObject({
            contracts: [{ id: "C1", network: "testnet" }],
        });
    });

    it("db import reads a JSON file and restores it", () => {
        const importSpy = vi.spyOn(backupModule, "importDatabase").mockImplementation(() => {});
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-db-"));
        const filePath = path.join(tempDir, "backup.json");
        fs.writeFileSync(filePath, JSON.stringify({
            contracts: [],
            contract_entries: [],
            extension_policies: [],
            alert_configs: [],
            channel_accounts: [],
            resource_alert_configs: [],
        }));

        const program = new Command();
        registerDbCommand(program);

        program.parse(["node", "sorokeep", "db", "import", filePath]);

        expect(importSpy).toHaveBeenCalledWith(mockDb, {
            contracts: [],
            contract_entries: [],
            extension_policies: [],
            alert_configs: [],
            channel_accounts: [],
            resource_alert_configs: [],
        });
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Database import complete"));

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("db status prints list of applied and pending migrations", () => {
        const getAppliedSpy = vi.spyOn(Migrator.prototype, "getAppliedMigrations").mockReturnValue([1, 2, 3]);
        const getPendingSpy = vi.spyOn(Migrator.prototype, "getPendingMigrations").mockReturnValue([
            { version: 4, filename: "004_test.sql", filepath: "/fake/004_test.sql" }
        ]);

        const program = new Command();
        registerDbCommand(program);

        program.parse(["node", "sorokeep", "db", "status"]);

        expect(getAppliedSpy).toHaveBeenCalled();
        expect(getPendingSpy).toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Version 1"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Version 2"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Version 3"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Version 4"));
    });

    it("db migrate runs pending migrations and prints applied migrations", () => {
        const getAppliedSpy = vi.spyOn(Migrator.prototype, "getAppliedMigrations").mockReturnValue([1, 2, 3, 4]);
        const getPendingSpy = vi.spyOn(Migrator.prototype, "getPendingMigrations").mockReturnValue([
            { version: 4, filename: "004_test.sql", filepath: "/fake/004_test.sql" }
        ]);
        const runSpy = vi.spyOn(Migrator.prototype, "run").mockImplementation(() => {});

        const program = new Command();
        registerDbCommand(program);

        program.parse(["node", "sorokeep", "db", "migrate"]);

        expect(getPendingSpy).toHaveBeenCalled();
        expect(runSpy).toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Migrations applied successfully"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Version 4"));
    });

    it("db vacuum executes successfully", () => {
        const vacuumSpy = vi.spyOn(dbModule, "vacuumDatabase").mockReturnValue(true);

        const program = new Command();
        registerDbCommand(program);

        program.parse(["node", "sorokeep", "db", "vacuum"]);

        expect(vacuumSpy).toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Database vacuum completed successfully"));
    });

    it("db vacuum prints warning/error if it fails to execute", () => {
        const vacuumSpy = vi.spyOn(dbModule, "vacuumDatabase").mockReturnValue(false);

        const program = new Command();
        registerDbCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "db", "vacuum"]);
        }).toThrow("process.exit called");

        expect(vacuumSpy).toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("Database vacuum completed successfully"));
    });
});

