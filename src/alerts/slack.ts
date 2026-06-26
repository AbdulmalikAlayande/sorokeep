import type { AlertEvent } from "./types.js";
import { loadConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "SlackHandler" });
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 10_000;

// ─── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the Slack Bot Token from config or environment.
 * Priority: SOROKEEP_SLACK_TOKEN env var > config.slackToken
 */
function resolveSlackToken(): string {
    const envToken = process.env["SOROKEEP_SLACK_TOKEN"];
    if (envToken) return envToken;

    const config = loadConfig();
    if (config.slackToken) return config.slackToken;

    throw new Error(
        "Slack token not configured. Set SOROKEEP_SLACK_TOKEN environment variable " +
        "or add slackToken to ~/.sorokeep/config.yaml.",
    );
}

// ─── Block Kit builder ────────────────────────────────────────────────────────

interface SlackBlock {
    type: string;
    [key: string]: unknown;
}

function severityEmoji(event: AlertEvent): string {
    if (event.type === "alert_resolved") return "✅";
    if (event.severity === "critical") return "🔴";
    return "⚠️";
}

function buildBlocks(event: AlertEvent): SlackBlock[] {
    const icon = severityEmoji(event);
    const contractDisplay = event.contractName ?? event.contractId;

    let status: string;
    if (event.type === "resource_alert") {
        const resourceType = event.resource.type === "cpu" ? "CPU" : "Memory";
        status = `Resource ${resourceType} ${event.severity === "critical" ? "CRITICAL" : "Warning"}`;
    } else if (event.type === "threshold_crossed") {
        status = `TTL ${event.severity === "critical" ? "CRITICAL" : "Warning"}`;
    } else {
        status = "Alert Resolved";
    }

    const header: SlackBlock = {
        type: "header",
        text: {
            type: "plain_text",
            text: `${icon} ${status} — ${contractDisplay}`,
            emoji: true,
        },
    };

    let details: SlackBlock;
    if (event.type === "resource_alert") {
        const resourceType = event.resource.type === "cpu" ? "CPU Instructions" : "Memory Bytes";
        const usageStr = event.resource.currentUsage.toLocaleString();
        const limitStr = event.resource.limit.toLocaleString();

        details = {
            type: "section",
            fields: [
                {
                    type: "mrkdwn",
                    text: `*Resource:*\n${event.resource.type.toUpperCase()}`,
                },
                {
                    type: "mrkdwn",
                    text: `*Network:*\n${event.network}`,
                },
                {
                    type: "mrkdwn",
                    text: `*Usage:*\n${usageStr} / ${limitStr} (${event.resource.usagePercent}%)`,
                },
                {
                    type: "mrkdwn",
                    text: `*Severity:*\n${event.severity}`,
                },
            ],
        };
    } else {
        details = {
            type: "section",
            fields: [
                {
                    type: "mrkdwn",
                    text: `*Entry:*\n${event.entry.label ?? event.entry.type}`,
                },
                {
                    type: "mrkdwn",
                    text: `*Network:*\n${event.network}`,
                },
                {
                    type: "mrkdwn",
                    text: `*Remaining TTL:*\n${event.threshold.currentRemainingLedgers.toLocaleString()} ledgers (${event.threshold.approximateTimeRemaining})`,
                },
                {
                    type: "mrkdwn",
                    text: `*Threshold:*\n${event.threshold.configuredLedgers.toLocaleString()} ledgers`,
                },
            ],
        };
    }

    const footer: SlackBlock = {
        type: "context",
        elements: [
            {
                type: "mrkdwn",
                text: `Severity: *${event.severity}* | Run \`sorokeep status ${event.contractId}\` for details.`,
            },
        ],
    };

    return [header, details, footer];
}

function buildFallbackText(event: AlertEvent): string {
    const icon = severityEmoji(event);
    const contractDisplay = event.contractName ?? event.contractId;

    if (event.type === "resource_alert") {
        const resourceType = event.resource.type === "cpu" ? "CPU" : "Memory";
        const status = `Resource ${resourceType} ${event.severity === "critical" ? "CRITICAL" : "Warning"}`;
        return (
            `${icon} ${status} — ${contractDisplay} (${event.network}) | ` +
            `Usage: ${event.resource.currentUsage.toLocaleString()} / ${event.resource.limit.toLocaleString()} ` +
            `(${event.resource.usagePercent}%)`
        );
    } else if (event.type === "threshold_crossed") {
        const status = `TTL ${event.severity === "critical" ? "CRITICAL" : "Warning"}`;
        return (
            `${icon} ${status} — ${contractDisplay} (${event.network}) | ` +
            `Remaining: ${event.threshold.currentRemainingLedgers.toLocaleString()} ledgers ` +
            `(${event.threshold.approximateTimeRemaining}) | ` +
            `Threshold: ${event.threshold.configuredLedgers.toLocaleString()} ledgers`
        );
    } else {
        return `${icon} Alert Resolved — ${contractDisplay} (${event.network})`;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an AlertEvent to a Slack channel via the Slack Web API.
 *
 * Resolves the Bot Token from env (SOROKEEP_SLACK_TOKEN) or config (slackToken).
 * Throws when the token is absent, the network fails, or Slack returns ok: false.
 * The caller (dispatcher) handles retry via the `delivered` flag.
 */
export async function sendSlackAlert(channel: string, event: AlertEvent): Promise<void> {
    const token = resolveSlackToken();

    logger.debug(`Sending Slack alert to ${channel}`, { type: event.type, contractId: event.contractId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(SLACK_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({
                channel,
                text: buildFallbackText(event),
                blocks: buildBlocks(event),
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(
            `Slack API request failed: HTTP ${response.status}`,
        );
    }

    // Slack always returns HTTP 200, but errors are in the body as ok: false
    const body = await response.json() as { ok: boolean; error?: string };
    if (!body.ok) {
        throw new Error(
            `Slack API error: ${body.error ?? "unknown error"}`,
        );
    }

    logger.debug(`Slack alert delivered successfully to ${channel}`);
}
