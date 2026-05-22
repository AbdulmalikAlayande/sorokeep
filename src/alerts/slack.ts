import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "SlackHandler" });
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 10_000;

// ─── Block Kit builder ────────────────────────────────────────────────────────

interface SlackBlock {
    type: string;
    [key: string]: unknown;
}

function buildBlocks(event: AlertEvent): SlackBlock[] {
    const isAlert = event.type === "threshold_crossed";
    const icon = isAlert ? "⚠️" : "✅";
    const status = isAlert ? "TTL Warning" : "Alert Resolved";
    const contractDisplay = event.contractName ?? event.contractId;

    const header: SlackBlock = {
        type: "header",
        text: {
            type: "plain_text",
            text: `${icon} ${status} — ${contractDisplay}`,
            emoji: true,
        },
    };

    const details: SlackBlock = {
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

    const footer: SlackBlock = {
        type: "context",
        elements: [
            {
                type: "mrkdwn",
                text: `Run \`sentinel status ${event.contractId}\` for details.`,
            },
        ],
    };

    return [header, details, footer];
}

export async function sendSlackAlert(channel: string, event: any): Promise<void> {}