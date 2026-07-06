import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderAlertTemplate } from "../../src/alerts/templates.js";
import type { AlertEvent } from "../../src/alerts/types.js";

const ttlEvent: AlertEvent = {
    type: "threshold_crossed",
    severity: "critical",
    contractId: "CA12345678901234567890123456789012345678901234567890123456",
    contractName: "TestContract",
    network: "testnet",
    entry: {
        keyXdr: "AAAAEgAAAA==",
        type: "instance",
        label: "Instance TTL",
    },
    threshold: {
        configuredLedgers: 10000,
        currentRemainingLedgers: 1500,
        approximateTimeRemaining: "2 hours",
    },
    firedAtLedger: 50000,
    timestamp: "2026-06-27T17:00:00.000Z",
};

const resourceEvent: AlertEvent = {
    type: "resource_alert",
    severity: "warning",
    contractId: "CA12345678901234567890123456789012345678901234567890123456",
    contractName: null,
    network: "testnet",
    resource: {
        type: "cpu",
        currentUsage: 85000000,
        limit: 100000000,
        usagePercent: 85,
    },
    message: "CPU usage is at 85% of limit",
    firedAtLedger: 50001,
    timestamp: "2026-06-27T17:01:00.000Z",
};

describe("Handlebars Alert Custom Templates", () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-templates-"));
        
        // Write custom templates
        fs.writeFileSync(
            path.join(tempDir, "telegram.hbs"),
            "[Custom Telegram] Contract: {{contractDisplay}}, Network: {{network}}, Remaining: {{threshold.currentRemainingLedgers}} ledgers",
            "utf8"
        );
        fs.writeFileSync(
            path.join(tempDir, "slack.hbs"),
            `{"text": "[Custom Slack] {{contractDisplay}} — {{severityEmoji}} {{severityLevel}}", "blocks": []}`,
            "utf8"
        );
        fs.writeFileSync(
            path.join(tempDir, "discord.hbs"),
            `{"username": "CustomBot", "content": "{{contractDisplay}} usage is at {{resource.usagePercent}}%"}`,
            "utf8"
        );
        fs.writeFileSync(
            path.join(tempDir, "webhook.hbs"),
            `{"myCustomEvent": "{{type}}", "myContract": "{{contractId}}"}`,
            "utf8"
        );
        fs.writeFileSync(
            path.join(tempDir, "pagerduty.hbs"),
            `{"payload": {"summary": "[Custom PD] {{contractDisplay}} - {{message}}"}}`,
            "utf8"
        );
    });

    afterAll(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // cleanup failed - ignore
        }
    });

    it("returns null if no custom templates path is configured", () => {
        const result = renderAlertTemplate("telegram", ttlEvent, undefined);
        expect(result).toBeNull();
    });

    it("returns null if the channel template file does not exist", () => {
        const result = renderAlertTemplate("nonexistent", ttlEvent, tempDir);
        expect(result).toBeNull();
    });

    it("renders custom Telegram template correctly for TTL event", () => {
        const result = renderAlertTemplate("telegram", ttlEvent, tempDir);
        expect(result).toBe("[Custom Telegram] Contract: TestContract, Network: testnet, Remaining: 1500 ledgers");
    });

    it("renders custom Slack template correctly using context helpers", () => {
        const result = renderAlertTemplate("slack", ttlEvent, tempDir);
        expect(result).toBe(`{"text": "[Custom Slack] TestContract — 🔴 CRITICAL", "blocks": []}`);
    });

    it("renders custom Discord template with fallback contract ID if name is null", () => {
        const result = renderAlertTemplate("discord", resourceEvent, tempDir);
        expect(result).toBe(`{"username": "CustomBot", "content": "CA12345678901234567890123456789012345678901234567890123456 usage is at 85%"}`);
    });

    it("renders custom Webhook template JSON successfully", () => {
        const result = renderAlertTemplate("webhook", ttlEvent, tempDir);
        expect(result).toBe(`{"myCustomEvent": "threshold_crossed", "myContract": "CA12345678901234567890123456789012345678901234567890123456"}`);
    });

    it("renders custom PagerDuty template successfully", () => {
        const result = renderAlertTemplate("pagerduty", resourceEvent, tempDir);
        expect(result).toBe(`{"payload": {"summary": "[Custom PD] CA12345678901234567890123456789012345678901234567890123456 - CPU usage is at 85% of limit"}}`);
    });
});
