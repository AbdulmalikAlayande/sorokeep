import type Database from "better-sqlite3";
import { buildAlertEvent, type AlertEvent } from "./types.js";
import {
    getUndeliveredAlerts,
    markAlertDelivered,
    incrementRetryCount,
    MAX_RETRY_COUNT,
    type UndeliveredAlert,
} from "../db/repositories.js";
import { sendWebhookAlert } from "./webhook.js";
import { sendSlackAlert } from "./slack.js";
import { sendPagerDutyAlert } from "./pagerduty.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "AlertDispatcher" });

export interface DeliveryResult {
    attempted: number;
    delivered: number;
    failed: number;
    abandoned: number;
    errors: string[];
}

function buildEvent(alert: UndeliveredAlert): AlertEvent {
    return buildAlertEvent({
        type: "threshold_crossed",
        contractId: alert.contractId,
        contractName: alert.contractName,
        network: alert.network,
        entryKeyXdr: alert.entryKeyXdr,
        entryType: alert.entryType,
        entryLabel: alert.entryLabel,
        configuredLedgers: alert.thresholdLedgers,
        remainingTTL: alert.remainingTTL,
        firedAtLedger: alert.firedAtLedger,
    });
}

async function dispatchToChannel(alert: UndeliveredAlert, event: AlertEvent): Promise<void> {
    switch (alert.channelType) {
        case "webhook":
            await sendWebhookAlert(alert.channelTarget, event, alert.webhookSecret);
            break;
        case "slack":
            await sendSlackAlert(alert.channelTarget, event);
            break;
        case "pagerduty":
            await sendPagerDutyAlert(alert.channelTarget, event);
            break;
        default:
            throw new Error(`Unsupported channel type: ${alert.channelType}`);
    }
}

export async function deliverPendingAlerts(
    db: Database.Database,
    network: string,
): Promise<DeliveryResult> {
    const alerts = getUndeliveredAlerts(db, network);
    const result: DeliveryResult = {
        attempted: 0,
        delivered: 0,
        failed: 0,
        abandoned: 0,
        errors: [],
    };

    for (const alert of alerts) {
        result.attempted += 1;

        const event = buildEvent(alert);

        try {
            await dispatchToChannel(alert, event);
            markAlertDelivered(db, alert.alertFiredId);
            result.delivered += 1;
        } catch (error: unknown) {
            incrementRetryCount(db, alert.alertFiredId);
            result.failed += 1;
            if (alert.retryCount + 1 >= MAX_RETRY_COUNT) {
                result.abandoned += 1;
            }
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(message);
            logger.warn(`Alert delivery failed for ${alert.contractId}: ${message}`);
        }
    }

    return result;
}

export async function deliverSingleAlert(
    channelType: "webhook" | "slack" | "pagerduty" | "discord" | "telegram",
    channelTarget: string,
    event: AlertEvent,
    secret?: string | null,
): Promise<boolean> {
    try {
        switch (channelType) {
            case "webhook":
                await sendWebhookAlert(channelTarget, event, secret);
                break;
            case "slack":
                await sendSlackAlert(channelTarget, event);
                break;
            case "pagerduty":
                await sendPagerDutyAlert(channelTarget, event);
                break;
            case "discord":
                await import("./discord.js").then(({ sendDiscordAlert }) => sendDiscordAlert(channelTarget, event));
                break;
            case "telegram":
                await import("./telegram.js").then(({ sendTelegramAlert }) => sendTelegramAlert(channelTarget, event));
                break;
            default:
                return false;
        }
        return true;
    } catch (error: unknown) {
        logger.warn(`Single alert delivery failed for ${channelType}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
