import Handlebars from "handlebars";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";
import type { AlertEvent } from "./types.js";

const logger = getLogger().child({ component: "AlertTemplates" });

// ─── Register Handlebars Helpers ─────────────────────────────────────────────

Handlebars.registerHelper("eq", (a, b) => a === b);
Handlebars.registerHelper("upperCase", (str) => typeof str === "string" ? str.toUpperCase() : str);
Handlebars.registerHelper("localeString", (num) => typeof num === "number" ? num.toLocaleString() : num);
Handlebars.registerHelper("json", (obj) => JSON.stringify(obj));
Handlebars.registerHelper("escapeJson", (str) => typeof str === "string" ? JSON.stringify(str).slice(1, -1) : str);
Handlebars.registerHelper("escapeMarkdown", (text) => typeof text === "string" ? text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&") : text);

// ─── Context Preparation ─────────────────────────────────────────────────────

export function getTemplateContext(event: AlertEvent) {
    const isResourceAlert = event.type === "resource_alert";
    const isResolved = event.type === "alert_resolved";
    const contractDisplay = event.contractName ?? event.contractId;

    let resourceLabel = "";
    let resourceUnit = "";
    let entryLabel = "";

    if (isResourceAlert) {
        resourceLabel = event.resource.type === "cpu" ? "CPU" : "Memory";
        resourceUnit = event.resource.type === "cpu" ? "instructions" : "bytes";
    } else {
        entryLabel = event.entry.label ?? event.entry.type;
    }

    const severityLevel = event.severity === "critical" ? "CRITICAL" : "Warning";

    // Dedup keys and details for channels like PagerDuty
    let dedupKey: string;
    let customDetails: Record<string, unknown>;

    if (isResourceAlert) {
        dedupKey = `sorokeep:${event.network}:${event.contractId}:resource:${event.resource.type}`;
        customDetails = {
            contractId: event.contractId,
            contractName: event.contractName,
            network: event.network,
            resourceType: event.resource.type,
            usagePercent: event.resource.usagePercent,
            currentUsage: event.resource.currentUsage,
            limit: event.resource.limit,
            firedAtLedger: event.firedAtLedger,
            timestamp: event.timestamp,
        };
    } else {
        const entryKey = event.entry.keyXdr || event.entry.type;
        dedupKey = `sorokeep:${event.network}:${event.contractId}:${entryKey}:${event.threshold.configuredLedgers}`;
        customDetails = {
            contractId: event.contractId,
            contractName: event.contractName,
            network: event.network,
            entryKeyXdr: event.entry.keyXdr,
            entryType: event.entry.type,
            entryLabel: event.entry.label,
            currentRemainingLedgers: event.threshold.currentRemainingLedgers,
            configuredLedgers: event.threshold.configuredLedgers,
            approximateTimeRemaining: event.threshold.approximateTimeRemaining,
            firedAtLedger: event.firedAtLedger,
            timestamp: event.timestamp,
        };
    }

    return {
        ...event,
        contractDisplay,
        resourceLabel,
        resourceUnit,
        severityLevel,
        entryLabel,
        severityEmoji: isResolved ? "✅" : (event.severity === "critical" ? "🔴" : "⚠️"),
        isTTLAlert: event.type === "threshold_crossed" || event.type === "alert_resolved",
        isResourceAlert,
        isResolved,
        isCritical: event.severity === "critical",
        isWarning: event.severity === "warning",
        isInfo: event.severity === "info",
        currentUsageFormatted: isResourceAlert ? event.resource.currentUsage.toLocaleString() : "",
        limitFormatted: isResourceAlert ? event.resource.limit.toLocaleString() : "",
        currentRemainingLedgersFormatted: !isResourceAlert ? event.threshold.currentRemainingLedgers.toLocaleString() : "",
        configuredLedgersFormatted: !isResourceAlert ? event.threshold.configuredLedgers.toLocaleString() : "",
        dedupKey,
        customDetails,
    };
}

// ─── Main Render API ─────────────────────────────────────────────────────────

export function renderAlertTemplate(channel: string, event: AlertEvent, customTemplatesPath?: string): string | null {
    // Priority: custom path parameter > config.templatesPath
    let templatesPath: string | undefined = customTemplatesPath;

    if (!templatesPath) {
        try {
            const config = loadConfig();
            if ("templatesPath" in config && typeof config.templatesPath === "string") {
                templatesPath = config.templatesPath;
            }
        } catch {
            // Ignore config loading errors during startup/tests
        }
    }

    if (!templatesPath) {
        return null;
    }

    const templateFile = path.join(templatesPath, `${channel}.hbs`);
    if (!fs.existsSync(templateFile)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(templateFile, "utf8");
        const template = Handlebars.compile(raw, { noEscape: true });
        const context = getTemplateContext(event);
        return template(context);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to render template ${templateFile}: ${msg}`);
        return null;
    }
}
