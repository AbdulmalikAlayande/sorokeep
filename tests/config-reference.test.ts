import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Config Reference Documentation", () => {
    it("should document all fields read from config or process.env in src/", () => {
        const docPath = path.join(process.cwd(), "docs", "config-reference.md");
        
        expect(fs.existsSync(docPath)).toBe(true);

        const docContent = fs.readFileSync(docPath, "utf-8");

        const requiredFields = [
            "network",
            "rpcUrl",
            "pollingIntervalSeconds",
            "slackToken",
            "telegramBotToken",
            "templatesPath",
            "monthlyBudgetXlm",
            "vault.url",
            "vault.token",
            "vault.namespace",
            "feeSponsorSecret",
            "mcp.mode",
            "smtp.host",
            "smtp.port",
            "smtp.user",
            "smtp.pass",
            "SOROKEEP_TELEGRAM_BOT_TOKEN",
            "SOROKEEP_SMTP_HOST",
            "SOROKEEP_SMTP_PORT",
            "SOROKEEP_SMTP_USER",
            "SOROKEEP_SMTP_PASS",
            "SOROKEEP_MATRIX_ACCESS_TOKEN",
            "SOROKEEP_MATRIX_HOMESERVER",
            "SOROKEEP_METRICS_TOKEN",
            "SOROKEEP_OTLP_ENDPOINT",
            "SOROKEEP_OTLP_IN_MEMORY",
        ];

        for (const field of requiredFields) {
            expect(docContent.includes(field)).toBe(true);
        }
    });
});
