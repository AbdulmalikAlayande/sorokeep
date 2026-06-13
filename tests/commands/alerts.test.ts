import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerAlertsCommand } from "../../src/commands/alerts";
import { insertContract, getAlertConfigsForContract, insertAlertConfig } from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

describe("alerts command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: any;
    let consoleErrorSpy: any;
    let exitSpy: any;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();
        insertContract(mockDb, {
            id: contractID,
            name: "sample-contract",
            network: "testnet",
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("adds a webhook alert configuration", () => {
        const program = new Command();
        registerAlertsCommand(program);

        program.parse([
            "node",
            "sentinel",
            "alerts",
            "add",
            "--contract",
            contractID,
            "--type",
            "webhook",
            "--url",
            "https://example.com/webhook",
            "--threshold",
            "1000",
        ]);

        const configs = getAlertConfigsForContract(mockDb, contractID);
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://example.com/webhook",
            threshold_ledgers: 1000,
        });
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("Successfully added alert config")
        );
    });

    it("adds a slack alert configuration", () => {
        const program = new Command();
        registerAlertsCommand(program);

        program.parse([
            "node",
            "sentinel",
            "alerts",
            "add",
            "--contract",
            contractID,
            "--type",
            "slack",
            "--channel",
            "#alerts-channel",
            "--threshold",
            "2000",
        ]);

        const configs = getAlertConfigsForContract(mockDb, contractID);
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            contract_id: contractID,
            channel_type: "slack",
            channel_target: "#alerts-channel",
            threshold_ledgers: 2000,
        });
    });

    it("rejects email alert type as not yet implemented", () => {
        const program = new Command();
        registerAlertsCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sentinel",
                "alerts",
                "add",
                "--contract",
                contractID,
                "--type",
                "email",
                "--url",
                "https://example.com",
                "--threshold",
                "3000",
            ]);
        }).toThrow("process.exit called");

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining("not yet implemented")
        );
    });

    it("fails if contract is not registered", () => {
        const program = new Command();
        registerAlertsCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sentinel",
                "alerts",
                "add",
                "--contract",
                "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                "--type",
                "webhook",
                "--url",
                "https://example.com",
                "--threshold",
                "1000",
            ]);
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining("is not registered")
        );
    });

    it("lists alert configurations", () => {
        insertAlertConfig(mockDb, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://example.com/webhook",
            threshold_ledgers: 1000,
        });

        const program = new Command();
        registerAlertsCommand(program);

        program.parse([
            "node",
            "sentinel",
            "alerts",
            "list",
            "--contract",
            contractID,
        ]);

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("Alert Configurations for")
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("https://example.com/webhook")
        );
    });

    it("removes an alert configuration", () => {
        insertAlertConfig(mockDb, {
            contract_id: contractID,
            channel_type: "webhook",
            channel_target: "https://example.com/webhook",
            threshold_ledgers: 1000,
        });

        const configs = getAlertConfigsForContract(mockDb, contractID);
        const configId = configs[0]!.id;

        const program = new Command();
        registerAlertsCommand(program);

        program.parse([
            "node",
            "sentinel",
            "alerts",
            "remove",
            "--id",
            configId.toString(),
        ]);

        const remaining = getAlertConfigsForContract(mockDb, contractID);
        expect(remaining).toHaveLength(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("Successfully removed alert config ID")
        );
    });
});
