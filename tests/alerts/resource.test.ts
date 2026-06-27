import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    insertResourceAlertConfig,
    recordResourceAlertFired
} from "../../src/db/repositories";
import { checkResourceLimitsAndAlert, deliverPendingResourceAlerts } from "../../src/alerts/resource";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSendWebhookAlert = vi.fn();
const mockSendSlackAlert = vi.fn();

vi.mock("../../src/alerts/webhook.js", () => ({
    sendWebhookAlert: (...args: unknown[]) => mockSendWebhookAlert(...args),
}));

vi.mock("../../src/alerts/slack.js", () => ({
    sendSlackAlert: (...args: unknown[]) => mockSendSlackAlert(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedContractWithResourceAlert(
    db: Database.Database,
    opts: {
        contractId: string;
        contractName?: string;
        network?: string;
        cpuLimit?: number;
        memLimit?: number;
        channelType?: "webhook" | "slack";
        channelTarget?: string;
        webhookSecret?: string;
    }
): { resourceAlertConfigId: number } {
    const network = opts.network ?? "testnet";

    insertContract(db, {
        id: opts.contractId,
        name: opts.contractName,
        network,
    });

    insertResourceAlertConfig(db, {
        contract_id: opts.contractId,
        channel_type: opts.channelType ?? "webhook",
        channel_target: opts.channelTarget ?? "https://example.com/hook",
        cpu_limit: opts.cpuLimit ?? 100_000_000,
        mem_limit: opts.memLimit ?? 50_000_000,
        webhook_secret: opts.webhookSecret,
    });

    const config = db
        .prepare("SELECT id FROM resource_alert_configs WHERE contract_id = ?")
        .get(opts.contractId) as { id: number };

    return { resourceAlertConfigId: config.id };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Resource Alert Detection and Dispatch", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. BASIC RESOURCE ALERT DETECTION
    // =========================================================================
    describe("Resource alert detection", () => {
        it("triggers a warning when CPU usage crosses 80% of limit", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                contractName: "test-contract",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            // Simulate transaction with CPU usage at 85% of limit
            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [url, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(url).toBe("https://ops.example.com/hook");
            expect(event.type).toBe("resource_alert");
            expect(event.severity).toBe("warning");
            expect(event.resource.type).toBe("cpu");
            expect(event.resource.usagePercent).toBe(85);
            expect(event.resource.currentUsage).toBe(85_000_000);
            expect(event.resource.limit).toBe(100_000_000);
        });

        it("triggers a critical alert when CPU usage exceeds 95% of limit", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 96_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
            expect(event.resource.usagePercent).toBe(96);
        });

        it("triggers a warning when memory usage crosses 80% of limit", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                memLimit: 50_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 50_000_000,
                memoryBytes: 42_000_000, // 84% of 50M limit
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.type).toBe("resource_alert");
            expect(event.severity).toBe("warning");
            expect(event.resource.type).toBe("memory");
            expect(event.resource.usagePercent).toBe(84);
            expect(event.resource.currentUsage).toBe(42_000_000);
            expect(event.resource.limit).toBe(50_000_000);
        });

        it("does not trigger an alert when usage is below 80% threshold", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 75_000_000, // 75% < 80%
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });

        it("triggers both CPU and memory alerts if both exceed thresholds", () => {
            mockSendWebhookAlert.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                memLimit: 50_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 85_000_000, // 85%
                memoryBytes: 42_000_000, // 84%
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(2);
            
            // First call should be CPU alert
            const [, cpuEvent] = mockSendWebhookAlert.mock.calls[0]!;
            expect(cpuEvent.resource.type).toBe("cpu");
            
            // Second call should be memory alert
            const [, memEvent] = mockSendWebhookAlert.mock.calls[1]!;
            expect(memEvent.resource.type).toBe("memory");
        });
    });

    // =========================================================================
    // 2. CHANNEL ROUTING FOR RESOURCE ALERTS
    // =========================================================================
    describe("Channel routing for resource alerts", () => {
        it("routes resource alerts to Slack when configured", () => {
            mockSendSlackAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "slack",
                channelTarget: "#alerts",
            });

            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
            
            const [channel, event] = mockSendSlackAlert.mock.calls[0]!;
            expect(channel).toBe("#alerts");
            expect(event.type).toBe("resource_alert");
        });

        it("includes webhook signature for signed webhooks", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
                webhookSecret: "test-secret-key",
            });

            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, , secret] = mockSendWebhookAlert.mock.calls[0]!;
            expect(secret).toBe("test-secret-key");
        });
    });

    // =========================================================================
    // 3. ALERT DEDUPLICATION & HISTORY
    // =========================================================================
    describe("Alert deduplication", () => {
        it("records resource alert in database when fired", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            const recorded = db
                .prepare(
                    `SELECT * FROM resource_alerts_fired 
                     WHERE resource_alert_config_id IN 
                     (SELECT id FROM resource_alert_configs WHERE contract_id = ?)`
                )
                .all("CTEST1234") as any[];

            expect(recorded.length).toBeGreaterThan(0);
            const cpuAlert = recorded.find((a) => a.resource_type === "cpu");
            expect(cpuAlert).toBeDefined();
            expect(cpuAlert.resource_type).toBe("cpu");
            expect(cpuAlert.usage).toBe(85_000_000);
            expect(cpuAlert.limit).toBe(100_000_000);
        });

        it("does not fire duplicate alerts within the same ledger for the same resource", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            // First call
            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);

            // Second call with same data
            mockSendWebhookAlert.mockClear();
            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            // Should not fire again - deduplication
            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });

        it("fires a new alert if resource consumption increases after a previous alert", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            // First alert at 85%
            const firstResourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };
            checkResourceLimitsAndAlert(db, "CTEST1234", firstResourceData);
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);

            // Second alert at 95% (should fire)
            mockSendWebhookAlert.mockClear();
            const secondResourceData = {
                cpuInstructions: 95_000_000,
                memoryBytes: 25_000_000,
            };
            checkResourceLimitsAndAlert(db, "CTEST1234", secondResourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
        });
    });

    // =========================================================================
    // 4. STANDARD SOROBAN LIMITS
    // =========================================================================
    describe("Standard Soroban limits", () => {
        it("treats 100M CPU instructions as the default limit", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            // Exactly at the limit
            const resourceData = {
                cpuInstructions: 100_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            // Should trigger critical alert at 100%
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
            expect(event.resource.usagePercent).toBe(100);
        });

        it("provides informative error message when limit is exceeded", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 105_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            const [, event] = mockSendWebhookAlert.mock.calls[0]!;
            expect(event.severity).toBe("critical");
            expect(event.resource.usagePercent).toBe(105);
            expect(event.message).toContain("exceeds");
        });
    });

    // =========================================================================
    // 5. EDGE CASES
    // =========================================================================
    describe("Edge cases", () => {
        it("handles zero resource usage gracefully", () => {
            const resourceData = {
                cpuInstructions: 0,
                memoryBytes: 0,
            };

            expect(() => {
                seedContractWithResourceAlert(db, {
                    contractId: "CTEST1234",
                    cpuLimit: 100_000_000,
                    channelType: "webhook",
                    channelTarget: "https://ops.example.com/hook",
                });
                checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);
            }).not.toThrow();

            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });

        it("handles missing resource alert config gracefully", () => {
            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            // No config created for this contract
            expect(() => {
                checkResourceLimitsAndAlert(db, "CNONEXISTENT", resourceData);
            }).not.toThrow();

            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });

        it("handles multiple alert configs for the same contract", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);

            insertContract(db, {
                id: "CTEST1234",
                network: "testnet",
            });

            // Create two alert configs
            insertResourceAlertConfig(db, {
                contract_id: "CTEST1234",
                channel_type: "webhook",
                channel_target: "https://webhook1.example.com",
                cpu_limit: 100_000_000,
                mem_limit: 50_000_000,
            });

            insertResourceAlertConfig(db, {
                contract_id: "CTEST1234",
                channel_type: "webhook",
                channel_target: "https://webhook2.example.com",
                cpu_limit: 100_000_000,
                mem_limit: 50_000_000,
            });

            const resourceData = {
                cpuInstructions: 85_000_000,
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            // Should alert both channels
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(2);
        });

        it("calculates usage percentage correctly for partial usage", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            const resourceData = {
                cpuInstructions: 33_333_333, // ~33.33%
                memoryBytes: 25_000_000,
            };

            checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

            // Should not alert (below 80%)
            expect(mockSendWebhookAlert).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 6. SEVERITY CALCULATION
    // =========================================================================
    describe("Severity calculation", () => {
        it("marks as 'warning' when usage is 80-95%", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            for (const percent of [80, 85, 90, 94.9]) {
                mockSendWebhookAlert.mockClear();
                const resourceData = {
                    cpuInstructions: Math.floor(100_000_000 * (percent / 100)),
                    memoryBytes: 25_000_000,
                };

                checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

                if (mockSendWebhookAlert.mock.calls.length > 0) {
                    const [, event] = mockSendWebhookAlert.mock.calls[0]!;
                    if (percent >= 80) {
                        expect(event.severity).toBe(percent >= 95 ? "critical" : "warning");
                    }
                }
            }
        });

        it("marks as 'critical' when usage is 95% or higher", () => {
            mockSendWebhookAlert.mockResolvedValue(undefined);
            seedContractWithResourceAlert(db, {
                contractId: "CTEST1234",
                cpuLimit: 100_000_000,
                channelType: "webhook",
                channelTarget: "https://ops.example.com/hook",
            });

            for (const percent of [95, 97.5, 100, 105]) {
                mockSendWebhookAlert.mockClear();
                const resourceData = {
                    cpuInstructions: Math.floor(100_000_000 * (percent / 100)),
                    memoryBytes: 25_000_000,
                };

                checkResourceLimitsAndAlert(db, "CTEST1234", resourceData);

                expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
                const [, event] = mockSendWebhookAlert.mock.calls[0]!;
                expect(event.severity).toBe("critical");
            }
        });
    });

    describe("deliverPendingResourceAlerts", () => {
        beforeEach(() => {
            mockSendWebhookAlert.mockReset();
            mockSendSlackAlert.mockReset();
        });

        it("delivers pending alerts and updates their status", async () => {
            const { resourceAlertConfigId } = seedContractWithResourceAlert(db, {
                contractId: "C123",
                channelType: "webhook",
                channelTarget: "http://example.com"
            });

            const alertId = recordResourceAlertFired(db, {
                resource_alert_config_id: resourceAlertConfigId,
                resource_type: "cpu",
                usage: 90000000,
                limit: 100000000,
                usage_percent: 90,
                fired_at_ledger: 100
            });

            mockSendWebhookAlert.mockResolvedValue(true);

            const result = await deliverPendingResourceAlerts(db, "testnet");
            
            expect(result.attempted).toBe(1);
            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(0);
            
            const row = db.prepare("SELECT delivered FROM resource_alerts_fired WHERE id = ?").get(alertId) as any;
            expect(row.delivered).toBe(1);
        });

        it("returns early if no pending alerts", async () => {
            const result = await deliverPendingResourceAlerts(db, "testnet");
            expect(result.attempted).toBe(0);
            expect(result.delivered).toBe(0);
        });

        it("handles delivery failure and retries", async () => {
            const { resourceAlertConfigId } = seedContractWithResourceAlert(db, {
                contractId: "C456",
                channelType: "webhook",
                channelTarget: "http://example.com"
            });

            const alertId = recordResourceAlertFired(db, {
                resource_alert_config_id: resourceAlertConfigId,
                resource_type: "cpu",
                usage: 90000000,
                limit: 100000000,
                usage_percent: 90,
                fired_at_ledger: 100
            });

            mockSendWebhookAlert.mockImplementation(() => {
                throw new Error("Network error");
            });

            let result = await deliverPendingResourceAlerts(db, "testnet");
            expect(mockSendWebhookAlert).toHaveBeenCalledTimes(1);
            expect(result.attempted).toBe(1);
            expect(result.failed).toBe(1);
            
            let row = db.prepare("SELECT delivered, retry_count FROM resource_alerts_fired WHERE id = ?").get(alertId) as any;
            expect(row.delivered).toBe(0);
            expect(row.retry_count).toBe(1);

            db.prepare("UPDATE resource_alerts_fired SET retry_count = 4 WHERE id = ?").run(alertId);
            
            result = await deliverPendingResourceAlerts(db, "testnet");
            expect(result.attempted).toBe(1);
            expect(result.failed).toBe(1);
            expect(result.abandoned).toBe(1);
            
            row = db.prepare("SELECT delivered, retry_count FROM resource_alerts_fired WHERE id = ?").get(alertId) as any;
            expect(row.delivered).toBe(0);
            expect(row.retry_count).toBe(5);
        });
    });
});
