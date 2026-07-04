import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerAlertsCommand } from "../../src/commands/alerts";
import {
    insertContract,
    getAlertConfigsForContract,
    insertAlertConfig,
    getResourceAlertConfigsForContract,
} from "../../src/db/repositories";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parse(args: string[]): void {
    const program = new Command();
    registerAlertsCommand(program);
    program.parse(["node", "sorokeep", ...args]);
}

function parseExpectExit(args: string[]): void {
    expect(() => parse(args)).toThrow("process.exit called");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("alerts command", () => {
    const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

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

    // =========================================================================
    // alerts add — happy paths
    // =========================================================================
    describe("alerts add — happy paths", () => {
        it("writes a webhook alert to SQLite", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/webhook",
                "--threshold", "1000",
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

        it("writes a slack alert to SQLite", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "slack",
                "--channel", "#alerts-channel",
                "--threshold", "2000",
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

        it("writes a pagerduty alert to SQLite", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "pagerduty",
                "--routing-key", "pagerduty-key-123",
                "--threshold", "3000",
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

        it("writes a discord alert to SQLite", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "discord",
                "--url", "https://discord.com/api/webhooks/123/abc",
                "--threshold", "1500",
            ]);

            const configs = getAlertConfigsForContract(mockDb, contractID);
            expect(configs).toHaveLength(1);
            expect(configs[0]).toMatchObject({
                contract_id: contractID,
                channel_type: "discord",
                channel_target: "https://discord.com/api/webhooks/123/abc",
                threshold_ledgers: 1500,
            });
        });

        it("writes a telegram alert to SQLite", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "telegram",
                "--channel", "@mychannel",
                "--threshold", "500",
            ]);

            const configs = getAlertConfigsForContract(mockDb, contractID);
            expect(configs).toHaveLength(1);
            expect(configs[0]).toMatchObject({
                contract_id: contractID,
                channel_type: "telegram",
                channel_target: "@mychannel",
                threshold_ledgers: 500,
            });
        });

        it("auto-generates a webhook secret when --secret is omitted", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/hook",
                "--threshold", "1000",
            ]);

            const configs = getAlertConfigsForContract(mockDb, contractID);
            expect(configs[0]!.webhook_secret).toBeTruthy();
            expect(typeof configs[0]!.webhook_secret).toBe("string");
        });

        it("stores the provided --secret for webhook alerts", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/hook",
                "--threshold", "1000",
                "--secret", "my-custom-secret",
            ]);

            const configs = getAlertConfigsForContract(mockDb, contractID);
            expect(configs[0]!.webhook_secret).toBe("my-custom-secret");
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("my-custom-secret")
            );
        });

        it("slack alert has no webhook secret", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "slack",
                "--channel", "#alerts",
                "--threshold", "1000",
            ]);

            const configs = getAlertConfigsForContract(mockDb, contractID);
            expect(configs[0]!.webhook_secret).toBeNull();
        });

        it("writes a resource alert with explicit cpu and mem limits", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/hook",
                "--cpu-limit", "50000000",
                "--mem-limit", "25000000",
            ]);

            const configs = getResourceAlertConfigsForContract(mockDb, contractID);
            expect(configs).toHaveLength(1);
            expect(configs[0]).toMatchObject({
                contract_id: contractID,
                cpu_limit: 50_000_000,
                mem_limit: 25_000_000,
            });
        });

        it("writes a resource alert using default limits when only --cpu-limit is provided", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/hook",
                "--cpu-limit", "80000000",
            ]);

            const configs = getResourceAlertConfigsForContract(mockDb, contractID);
            expect(configs).toHaveLength(1);
            expect(configs[0]!.cpu_limit).toBe(80_000_000);
            expect(configs[0]!.mem_limit).toBe(50_000_000); // default
        });

        it("writes a resource alert using default limits when only --mem-limit is provided", () => {
            parse([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com/hook",
                "--mem-limit", "30000000",
            ]);

            const configs = getResourceAlertConfigsForContract(mockDb, contractID);
            expect(configs).toHaveLength(1);
            expect(configs[0]!.cpu_limit).toBe(100_000_000); // default
            expect(configs[0]!.mem_limit).toBe(30_000_000);
        });
    });

    // =========================================================================
    // alerts add — validation failures
    // =========================================================================
    describe("alerts add — validation failures", () => {
        it("exits with 1 when the contract is not registered", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                "--type", "webhook",
                "--url", "https://example.com",
                "--threshold", "1000",
            ]);

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("is not registered")
            );
        });

        it("exits with 1 for email type (not implemented)", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "email",
                "--url", "https://example.com",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("not yet implemented")
            );
        });

        it("exits with 1 for an unknown channel type", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "fax",
                "--url", "https://example.com",
                "--threshold", "1000",
            ]);

            expect(exitSpy).toHaveBeenCalledWith(1);
        });

        it("exits with 1 when --threshold is missing and no resource flags are given", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--threshold")
            );
        });

        it("exits with 1 when both --threshold and resource limits are given", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com",
                "--threshold", "1000",
                "--cpu-limit", "50000000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Cannot mix")
            );
        });

        it("exits with 1 when --threshold is zero", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com",
                "--threshold", "0",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--threshold must be a positive integer")
            );
        });

        it("exits with 1 when --threshold is negative", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--url", "https://example.com",
                "--threshold", "-500",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--threshold must be a positive integer")
            );
        });

        it("exits with 1 when webhook is missing --url", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--url is required")
            );
        });

        it("exits with 1 when slack is missing --channel", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "slack",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--channel is required")
            );
        });

        it("exits with 1 when pagerduty is missing --routing-key", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "pagerduty",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--routing-key is required")
            );
        });

        it("exits with 1 when discord is missing --url", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "discord",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--url is required")
            );
        });

        it("exits with 1 when telegram is missing --channel", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "telegram",
                "--threshold", "1000",
            ]);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--channel is required")
            );
        });

        it("does not write to DB when validation fails", () => {
            parseExpectExit([
                "alerts", "add",
                "--contract", contractID,
                "--type", "webhook",
                "--threshold", "1000",
            ]);

            expect(getAlertConfigsForContract(mockDb, contractID)).toHaveLength(0);
        });
    });

    // =========================================================================
    // alerts list — happy paths and edge cases
    // =========================================================================
    describe("alerts list", () => {
        it("prints a console table with channel type, target, and threshold", () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/webhook",
                threshold_ledgers: 1000,
            });

            parse(["alerts", "list", "--contract", contractID]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("Alert Configurations for")
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("https://example.com/webhook")
            );
            // Threshold is formatted via toLocaleString — verify the number appears somewhere
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("ledgers")
            );
        });

        it("shows the [signed] indicator for webhooks with a secret", () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/signed",
                threshold_ledgers: 500,
                webhook_secret: "super-secret",
            });

            parse(["alerts", "list", "--contract", contractID]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("[signed]")
            );
        });

        it("prints a warning message when no alerts are configured for the contract", () => {
            parse(["alerts", "list", "--contract", contractID]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("No alert configurations found")
            );
        });

        it("lists all alerts when multiple are configured", () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/hook1",
                threshold_ledgers: 1000,
            });
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "slack",
                channel_target: "#ops",
                threshold_ledgers: 2000,
            });

            parse(["alerts", "list", "--contract", contractID]);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("https://example.com/hook1")
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("#ops")
            );
        });

        it("exits with 1 when the contract is not registered", () => {
            parseExpectExit([
                "alerts", "list",
                "--contract", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            ]);

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("is not registered")
            );
        });
    });

    // =========================================================================
    // alerts remove — happy paths and edge cases
    // =========================================================================
    describe("alerts remove", () => {
        it("deletes the alert config from the DB", () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/webhook",
                threshold_ledgers: 1000,
            });

            const configs = getAlertConfigsForContract(mockDb, contractID);
            const configId = configs[0]!.id;

            parse(["alerts", "remove", "--id", configId.toString()]);

            expect(getAlertConfigsForContract(mockDb, contractID)).toHaveLength(0);
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("Successfully removed alert config ID")
            );
        });

        it("removes only the targeted config when multiple exist", () => {
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "webhook",
                channel_target: "https://example.com/hook1",
                threshold_ledgers: 1000,
            });
            insertAlertConfig(mockDb, {
                contract_id: contractID,
                channel_type: "slack",
                channel_target: "#ops",
                threshold_ledgers: 2000,
            });

            const configs = getAlertConfigsForContract(mockDb, contractID);
            const webhookId = configs.find(c => c.channel_type === "webhook")!.id;

            parse(["alerts", "remove", "--id", webhookId.toString()]);

            const remaining = getAlertConfigsForContract(mockDb, contractID);
            expect(remaining).toHaveLength(1);
            expect(remaining[0]!.channel_type).toBe("slack");
        });

        it("exits with 1 when --id is not a number", () => {
            parseExpectExit(["alerts", "remove", "--id", "not-a-number"]);

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("--id must be a number")
            );
        });
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
