import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerAlertsCommand } from "../../src/commands/alerts";
import { insertContract, getAlertConfigsForContract, insertAlertConfig } from "../../src/db/repositories";

let mockDb: Database.Database;

const mockDeliverSingleAlert = vi.fn();

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverSingleAlert: (...args: unknown[]) => mockDeliverSingleAlert(...args),
}));

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
            "sorokeep",
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
            "sorokeep",
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

    it("adds a pagerduty alert configuration", () => {
        const program = new Command();
        registerAlertsCommand(program);

        program.parse([
            "node",
            "sorokeep",
            "alerts",
            "add",
            "--contract",
            contractID,
            "--type",
            "pagerduty",
            "--routing-key",
            "pagerduty-key-123",
            "--threshold",
            "3000",
        ]);

        const configs = getAlertConfigsForContract(mockDb, contractID);
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            contract_id: contractID,
            channel_type: "pagerduty",
            channel_target: "pagerduty-key-123",
            threshold_ledgers: 3000,
        });
    });

    it("rejects email alert type as not yet implemented", () => {
        const program = new Command();
        registerAlertsCommand(program);

        expect(() => {
            program.parse([
                "node",
                "sorokeep",
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
                "sorokeep",
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
            "sorokeep",
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
            "sorokeep",
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

    describe("alerts test", () => {
        let webhookConfigId: number;

        beforeEach(() => {
            mockDeliverSingleAlert.mockReset();
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/webhook",
                threshold_ledgers: 1000,
            });
            const configs = getAlertConfigsForContract(mockDb, contractID);
            webhookConfigId = configs[0]!.id;
        });

        it("calls deliverSingleAlert with the correct channel type, target, and event", async () => {
            mockDeliverSingleAlert.mockResolvedValue(true);

            const program = new Command();
            registerAlertsCommand(program);

            await program.parseAsync([
                "node", "sorokeep", "alerts", "test",
                "--id", webhookConfigId.toString(),
            ]);

            expect(mockDeliverSingleAlert).toHaveBeenCalledTimes(1);
            const [channelType, channelTarget, event] = mockDeliverSingleAlert.mock.calls[0]!;
            expect(channelType).toBe("webhook");
            expect(channelTarget).toBe("https://example.com/webhook");
            expect(event.type).toBe("threshold_crossed");
            expect(event.contractId).toBe(contractID);
        });

        it("sends a threshold_crossed event with valid fields", async () => {
            mockDeliverSingleAlert.mockResolvedValue(true);

            const program = new Command();
            registerAlertsCommand(program);

            await program.parseAsync([
                "node", "sorokeep", "alerts", "test",
                "--id", webhookConfigId.toString(),
            ]);

            const [, , event] = mockDeliverSingleAlert.mock.calls[0]!;
            expect(event.type).toBe("threshold_crossed");
            expect(typeof event.timestamp).toBe("string");
            expect(() => new Date(event.timestamp)).not.toThrow();
            expect(event.threshold.configuredLedgers).toBe(1000);
            expect(event.threshold.currentRemainingLedgers).toBeGreaterThan(0);
        });

        it("prints success message when delivery succeeds", async () => {
            mockDeliverSingleAlert.mockResolvedValue(true);

            const program = new Command();
            registerAlertsCommand(program);

            await program.parseAsync([
                "node", "sorokeep", "alerts", "test",
                "--id", webhookConfigId.toString(),
            ]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("Test alert delivered successfully")
            );
        });

        it("prints error and exits with 1 when delivery fails", async () => {
            mockDeliverSingleAlert.mockResolvedValue(false);

            const program = new Command();
            registerAlertsCommand(program);

            await expect(
                program.parseAsync([
                    "node", "sorokeep", "alerts", "test",
                    "--id", webhookConfigId.toString(),
                ])
            ).rejects.toThrow("process.exit called");

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Test alert delivery failed")
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
        });

        it("exits with error when alert config ID is not found", async () => {
            const program = new Command();
            registerAlertsCommand(program);

            await expect(
                program.parseAsync([
                    "node", "sorokeep", "alerts", "test",
                    "--id", "99999",
                ])
            ).rejects.toThrow("process.exit called");

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Alert config ID 99999 not found")
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockDeliverSingleAlert).not.toHaveBeenCalled();
        });

        it("exits with error when --id is not a number", async () => {
            const program = new Command();
            registerAlertsCommand(program);

            await expect(
                program.parseAsync([
                    "node", "sorokeep", "alerts", "test",
                    "--id", "not-a-number",
                ])
            ).rejects.toThrow("process.exit called");

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--id must be a number")
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockDeliverSingleAlert).not.toHaveBeenCalled();
        });

        it("passes the webhook secret from config to deliverSingleAlert", async () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/signed",
                threshold_ledgers: 500,
                webhook_secret: "my-signing-secret",
            });
            const allConfigs = getAlertConfigsForContract(mockDb, contractID);
            const signedConfig = allConfigs.find((c) => c.webhook_secret === "my-signing-secret")!;

            mockDeliverSingleAlert.mockResolvedValue(true);

            const program = new Command();
            registerAlertsCommand(program);

            await program.parseAsync([
                "node", "sorokeep", "alerts", "test",
                "--id", signedConfig.id.toString(),
            ]);

            const [, , , secret] = mockDeliverSingleAlert.mock.calls[0]!;
            expect(secret).toBe("my-signing-secret");
        });

        it("delivers a test alert to a slack channel", async () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "slack",
                channel_target: "#alerts-channel",
                threshold_ledgers: 2000,
            });
            const allConfigs = getAlertConfigsForContract(mockDb, contractID);
            const slackConfig = allConfigs.find((c) => c.channel_type === "slack")!;

            mockDeliverSingleAlert.mockResolvedValue(true);

            const program = new Command();
            registerAlertsCommand(program);

            await program.parseAsync([
                "node", "sorokeep", "alerts", "test",
                "--id", slackConfig.id.toString(),
            ]);

            expect(mockDeliverSingleAlert).toHaveBeenCalledTimes(1);
            const [channelType, channelTarget] = mockDeliverSingleAlert.mock.calls[0]!;
            expect(channelType).toBe("slack");
            expect(channelTarget).toBe("#alerts-channel");
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("Test alert delivered successfully")
            );
        });
    });
});
