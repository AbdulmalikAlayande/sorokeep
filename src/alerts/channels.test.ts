import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendSlackAlert } from "../../src/alerts/slack";
import { sendPagerDutyAlert } from "../../src/alerts/pagerduty";
import { sendDiscordAlert } from "../../src/alerts/discord";
import { sendTelegramAlert } from "../../src/alerts/telegram";
import { sendWebhookAlert } from "../../src/alerts/webhook";
import type { AlertEvent } from "../../src/alerts/types";
import { loadConfig } from "../../src/utils/config";

vi.mock("../../src/utils/config", () => ({
    loadConfig: vi.fn(),
}));

const mockLoadConfig = vi.mocked(loadConfig);
const fetchSpy = vi.spyOn(global, "fetch");

describe("Alert Channels", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env = {}; // Clear env for fresh config resolution
        
        // Default successful fetch
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ ok: true }),
            text: async () => "OK"
        } as Response);
    });

    const mockEvent: AlertEvent = {
        type: "threshold_crossed",
        network: "testnet",
        contractId: "C1234",
        contractName: "TestContract",
        severity: "critical",
        message: "TTL critical",
        entry: { type: "ContractData", label: "State" },
        threshold: {
            currentRemainingLedgers: 10,
            configuredLedgers: 20,
            approximateTimeRemaining: "1m"
        },
    };

    const mockResourceEvent: AlertEvent = {
        type: "resource_alert",
        network: "testnet",
        contractId: "C1234",
        severity: "warning",
        message: "CPU high",
        resource: {
            type: "cpu",
            currentUsage: 90,
            limit: 100,
            usagePercent: 90
        }
    };

    describe("Slack", () => {
        it("throws if no slack token provided", async () => {
            mockLoadConfig.mockReturnValue({});
            await expect(sendSlackAlert("C123", mockEvent)).rejects.toThrow(/Slack token not configured/);
        });

        it("sends slack message successfully using env var token", async () => {
            process.env.SOROKEEP_SLACK_TOKEN = "xoxb-env-token";
            await sendSlackAlert("C123", mockEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe("https://slack.com/api/chat.postMessage");
            expect(init?.headers).toMatchObject({
                Authorization: "Bearer xoxb-env-token",
                "Content-Type": "application/json"
            });
        });

        it("sends slack message successfully using config token", async () => {
            mockLoadConfig.mockReturnValue({ slackToken: "xoxb-config-token" });
            await sendSlackAlert("C123", mockResourceEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("throws if slack API returns error", async () => {
            process.env.SOROKEEP_SLACK_TOKEN = "token";
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: async () => "invalid_auth"
            } as Response);

            await expect(sendSlackAlert("C123", mockEvent)).rejects.toThrow(/Slack API request failed: HTTP 400/);
        });
        
        it("throws if slack API returns success but payload has error", async () => {
            process.env.SOROKEEP_SLACK_TOKEN = "token";
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ok: false, error: "channel_not_found" })
            } as Response);

            await expect(sendSlackAlert("C123", mockEvent)).rejects.toThrow(/Slack API error: channel_not_found/);
        });
    });

    describe("PagerDuty", () => {
        it("sends pagerduty event successfully", async () => {
            await sendPagerDutyAlert("integration-key", mockEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
            expect(init?.headers).toMatchObject({
                "Content-Type": "application/json"
            });
        });

        it("handles resource alerts for pagerduty", async () => {
            await sendPagerDutyAlert("integration-key", mockResourceEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("handles resolved alerts for pagerduty", async () => {
            await sendPagerDutyAlert("integration-key", {
                ...mockEvent,
                type: "alert_resolved",
                severity: "info",
                message: "Resolved"
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("throws on non-202 status", async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: async () => "invalid"
            } as Response);
            await expect(sendPagerDutyAlert("key", mockEvent)).rejects.toThrow(/PagerDuty API request failed: HTTP 400/);
        });
    });

    describe("Discord", () => {
        it("sends discord webhook successfully", async () => {
            await sendDiscordAlert("https://discord.com/api/webhooks/123/abc", mockEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("sends discord webhook for resource alerts", async () => {
            await sendDiscordAlert("https://discord.com/api/webhooks/123/abc", mockResourceEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
        
        it("throws on discord api error", async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: "Not Found",
                text: async () => "webhook not found"
            } as Response);
            await expect(sendDiscordAlert("https://discord.com/api/webhooks/123/abc", mockEvent)).rejects.toThrow(/Discord webhook request failed: HTTP 404/);
        });
    });

    describe("Telegram", () => {
        it("throws if no telegram bot token provided", async () => {
            mockLoadConfig.mockReturnValue({});
            await expect(sendTelegramAlert("chat_id", mockEvent)).rejects.toThrow(/Telegram bot token not configured/);
        });

        it("sends telegram message successfully", async () => {
            process.env.SOROKEEP_TELEGRAM_BOT_TOKEN = "bot-token";
            await sendTelegramAlert("chat_id", mockEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("sends telegram message for resource alerts", async () => {
            process.env.SOROKEEP_TELEGRAM_BOT_TOKEN = "bot-token";
            await sendTelegramAlert("chat_id", mockResourceEvent);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("throws on telegram api error", async () => {
            process.env.SOROKEEP_TELEGRAM_BOT_TOKEN = "bot-token";
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                text: async () => "invalid token"
            } as Response);
            await expect(sendTelegramAlert("chat_id", mockEvent)).rejects.toThrow(/Telegram API request failed: HTTP 401/);
        });
    });

    describe("Webhook", () => {
        it("sends simple webhook successfully", async () => {
            await sendWebhookAlert("http://custom.webhook", mockEvent, null);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
        
        it("sends signed webhook successfully", async () => {
            await sendWebhookAlert("http://custom.webhook", mockEvent, "secret-key");
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [, init] = fetchSpy.mock.calls[0];
            expect(init?.headers).toHaveProperty("X-Sorokeep-Signature");
        });

        it("throws on webhook error", async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Internal Error",
                text: async () => "server error"
            } as Response);
            await expect(sendWebhookAlert("http://url", mockEvent, null)).rejects.toThrow(/Webhook delivery failed: HTTP 500 from http:\/\/url/);
        });
    });
});
