import type { AlertEvent, AlertSeverity } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "DiscordHandler" });
const TIMEOUT_MS = 10_000;

// ─── Discord embed color palette ─────────────────────────────────────────────

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
    critical: 0xFF0000,  // red
    warning: 0xFFA500,   // orange
    info: 0x00CC44,      // green
};

// ─── Discord embed builder ────────────────────────────────────────────────────

interface DiscordField {
    name: string;
    value: string;
    inline?: boolean;
}

interface DiscordEmbed {
    title: string;
    color: number;
    fields: DiscordField[];
    footer: { text: string };
    timestamp: string;
}

function severityEmoji(event: AlertEvent): string {
    if (event.type === "alert_resolved") return "✅";
    if (event.severity === "critical") return "🔴";
    return "⚠️";
}

function buildTitle(event: AlertEvent): string {
    const icon = severityEmoji(event);
    const contractDisplay = event.contractName ?? event.contractId;

    if (event.type === "alert_resolved") {
        return `${icon} Alert Resolved — ${contractDisplay}`;
    }

    const level = event.severity === "critical" ? "CRITICAL" : "Warning";
    return `${icon} TTL ${level} — ${contractDisplay}`;
}

function buildEmbed(event: AlertEvent): DiscordEmbed {
    const contractDisplay = event.contractName ?? event.contractId;

    const fields: DiscordField[] = [
        {
            name: "Contract",
            value: contractDisplay,
            inline: true,
        },
        {
            name: "Network",
            value: event.network,
            inline: true,
        },
    ];

    if (event.type === "resource_alert") {
        fields.push(
            {
                name: "Resource",
                value: event.resource.type === "cpu" ? "CPU" : "Memory",
                inline: true,
            },
            {
                name: "Usage",
                value: `${event.resource.usagePercent}% (${event.resource.currentUsage.toLocaleString()} / ${event.resource.limit.toLocaleString()})`,
                inline: true,
            },
            {
                name: "Severity",
                value: event.severity.toUpperCase(),
                inline: true,
            }
        );
    } else {
        fields.push(
            {
                name: "Entry",
                value: event.entry.label ?? event.entry.type,
                inline: true,
            },
            {
                name: "Remaining TTL",
                value: `${event.threshold.currentRemainingLedgers.toLocaleString()} ledgers (${event.threshold.approximateTimeRemaining})`,
                inline: true,
            },
            {
                name: "Alert Threshold",
                value: `${event.threshold.configuredLedgers.toLocaleString()} ledgers`,
                inline: true,
            },
            {
                name: "Severity",
                value: event.severity.toUpperCase(),
                inline: true,
            }
        );
    }

    return {
        title: buildTitle(event),
        color: SEVERITY_COLORS[event.severity],
        fields,
        footer: {
            text: `Run \`sorokeep status ${event.contractId}\` for details.`,
        },
        timestamp: event.timestamp,
    };
}

// ─── Webhook URL validation ───────────────────────────────────────────────────

function validateWebhookUrl(webhookUrl: string): void {
    if (!webhookUrl) {
        throw new Error(
            "Discord webhook URL is required. " +
            "Pass the full URL from your Discord channel's Integrations → Webhooks settings.",
        );
    }

    let parsed: URL;
    try {
        parsed = new URL(webhookUrl);
    } catch {
        throw new Error(
            `Invalid Discord webhook URL: "${webhookUrl}". ` +
            "Expected a URL like https://discord.com/api/webhooks/<id>/<token>.",
        );
    }

    if (!parsed.hostname.includes("discord")) {
        throw new Error(
            `Invalid Discord webhook URL: "${webhookUrl}". ` +
            "Expected a URL like https://discord.com/api/webhooks/<id>/<token>.",
        );
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendDiscordAlert(webhookUrl: string, event: AlertEvent): Promise<void> {
    validateWebhookUrl(webhookUrl);

    logger.debug(`Sending Discord alert to webhook`, {
        type: event.type,
        contractId: event.contractId,
        severity: event.severity,
    });

    const payload = {
        username: "Sorokeep",
        embeds: [buildEmbed(event)],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    // Discord returns 204 No Content on success
    if (!response.ok) {
        let detail = "";
        try {
            const body = await response.json() as { message?: string };
            if (body.message) detail = `: ${body.message}`;
        } catch {
            // body not JSON — ignore
        }
        throw new Error(
            `Discord webhook request failed: HTTP ${response.status}${detail}`,
        );
    }

    logger.debug(`Discord alert delivered successfully`);
}