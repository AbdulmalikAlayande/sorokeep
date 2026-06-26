import type { AlertEvent } from "./types.js";
import { loadConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "TelegramHandler" });
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const TIMEOUT_MS = 10_000;

// ─── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the Telegram Bot Token from env or config.
 * Priority: SOROKEEP_TELEGRAM_BOT_TOKEN env var > config.telegramBotToken
 */
function resolveBotToken(): string {
    const envToken = process.env["SOROKEEP_TELEGRAM_BOT_TOKEN"];
    if (envToken) return envToken;

    const config = loadConfig();
    if ("telegramBotToken" in config && typeof config.telegramBotToken === "string" && config.telegramBotToken) {
        return config.telegramBotToken as string;
    }

    throw new Error(
        "Telegram bot token not configured. Set SOROKEEP_TELEGRAM_BOT_TOKEN environment variable " +
        "or add telegramBotToken to ~/.sorokeep/config.yaml.",
    );
}

// ─── Message builder ──────────────────────────────────────────────────────────

function severityEmoji(event: AlertEvent): string {
    if (event.type === "alert_resolved") return "✅";
    if (event.severity === "critical") return "🔴";
    return "⚠️";
}

function buildMessage(event: AlertEvent): string {
    const icon = severityEmoji(event);
    const contractDisplay = event.contractName ?? event.contractId;

    if (event.type === "resource_alert") {
        const level = event.severity === "critical" ? "CRITICAL" : "Warning";
        const resourceLabel = event.resource.type === "cpu" ? "CPU" : "Memory";
        
        return [
            `${icon} *Resource ${level}* — ${escapeMarkdown(contractDisplay)}`,
            ``,
            `*Resource:* ${resourceLabel}`,
            `*Network:* ${escapeMarkdown(event.network)}`,
            `*Usage:* ${event.resource.usagePercent}% \\(${event.resource.currentUsage.toLocaleString()} / ${event.resource.limit.toLocaleString()}\\)`,
            ``,
            `_Severity: ${escapeMarkdown(event.severity)} \\| Contract: ${escapeMarkdown(event.contractId)}_`,
        ].join("\n");
    }

    const status = event.type === "threshold_crossed"
        ? `TTL ${event.severity === "critical" ? "CRITICAL" : "Warning"}`
        : "Alert Resolved";

    const entryLabel = event.entry.label ?? event.entry.type;

    return [
        `${icon} *${status}* — ${escapeMarkdown(contractDisplay)}`,
        ``,
        `*Entry:* ${escapeMarkdown(entryLabel)}`,
        `*Network:* ${escapeMarkdown(event.network)}`,
        `*Remaining TTL:* ${event.threshold.currentRemainingLedgers.toLocaleString()} ledgers \\(${escapeMarkdown(event.threshold.approximateTimeRemaining)}\\)`,
        `*Threshold:* ${event.threshold.configuredLedgers.toLocaleString()} ledgers`,
        ``,
        `_Severity: ${escapeMarkdown(event.severity)} \\| Contract: ${escapeMarkdown(event.contractId)}_`,
    ].join("\n");
}

/**
 * Escape special characters for Telegram MarkdownV2 format.
 */
function escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an AlertEvent to a Telegram chat or channel via the Bot API.
 *
 * Resolves the bot token from env (SOROKEEP_TELEGRAM_BOT_TOKEN) or config (telegramBotToken).
 * Throws when the token is absent, the network fails, or Telegram returns ok: false.
 */
export async function sendTelegramAlert(chatId: string, event: AlertEvent): Promise<void> {
    const token = resolveBotToken();

    logger.debug(`Sending Telegram alert to ${chatId}`, { type: event.type, contractId: event.contractId });

    const url = `${TELEGRAM_API_BASE}${token}/sendMessage`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: buildMessage(event),
                parse_mode: "MarkdownV2",
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(
            `Telegram API request failed: HTTP ${response.status}`,
        );
    }

    const body = await response.json() as { ok: boolean; description?: string };
    if (!body.ok) {
        throw new Error(
            `Telegram API error: ${body.description ?? "unknown error"}`,
        );
    }

    logger.debug(`Telegram alert delivered successfully to ${chatId}`);
}
