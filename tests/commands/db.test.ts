/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerDbCommand } from "../../src/commands/db";
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
    let exitSpy: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true as any);
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
});
