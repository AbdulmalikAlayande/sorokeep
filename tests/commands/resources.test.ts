import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerResourcesCommand } from "../../src/commands/resources";
import { insertContract, insertResourceAlertConfig, recordResourceAlertFired } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("resources command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: any;
    let consoleErrorSpy: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prints resource usage averages when records exist", () => {
        insertResourceAlertConfig(mockDb, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://example.com",
            cpu_limit: 100000000,
            mem_limit: 50000000,
        });

        const config = mockDb.prepare("SELECT id FROM resource_alert_configs WHERE contract_id = ?").get(contractID);
        expect(config).toBeDefined();

        recordResourceAlertFired(mockDb, {
            resource_alert_config_id: config.id,
            resource_type: "cpu",
            usage: 50_000_000,
            limit: 100_000_000,
            usage_percent: 50,
            fired_at_ledger: 100,
        });

        recordResourceAlertFired(mockDb, {
            resource_alert_config_id: config.id,
            resource_type: "cpu",
            usage: 80_000_000,
            limit: 100_000_000,
            usage_percent: 80,
            fired_at_ledger: 101,
        });

        recordResourceAlertFired(mockDb, {
            resource_alert_config_id: config.id,
            resource_type: "memory",
            usage: 20_000_000,
            limit: 50_000_000,
            usage_percent: 40,
            fired_at_ledger: 102,
        });

        const program = new Command();
        registerResourcesCommand(program);

        program.parse(["node", "sorokeep", "resources", contractID]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Resource Usage Trends"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("CPU"));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Memory"));
    });

    it("accepts --period and filters history records", () => {
        insertResourceAlertConfig(mockDb, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://example.com",
            cpu_limit: 100000000,
            mem_limit: 50000000,
        });

        const config = mockDb.prepare("SELECT id FROM resource_alert_configs WHERE contract_id = ?").get(contractID);

        recordResourceAlertFired(mockDb, {
            resource_alert_config_id: config.id,
            resource_type: "cpu",
            usage: 50_000_000,
            limit: 100_000_000,
            usage_percent: 50,
            fired_at_ledger: 100,
        });

        const program = new Command();
        registerResourcesCommand(program);

        program.parse(["node", "sorokeep", "resources", contractID, "--period", "30"]);

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Resource Usage Trends"));
    });

    it("errors when --period is invalid", () => {
        const program = new Command();
        registerResourcesCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "resources", contractID, "--period", "-5"]);
        }).toThrow("process.exit called");

        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--period must be a positive integer"));
    });

    it("errors when contract is not registered", () => {
        const program = new Command();
        registerResourcesCommand(program);

        expect(() => {
            program.parse(["node", "sorokeep", "resources", "CUNKNOWNCONTRACTID"]);
        }).toThrow("process.exit called");

        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found. Run 'sorokeep watch' first."));
    });
});
