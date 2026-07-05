import type Database from "better-sqlite3";
import { getUndeliveredAlerts, markAlertDelivered, incrementRetryCount, MAX_RETRY_COUNT } from "../db/repositories.js";
import { buildAlertEvent, type AlertEvent, type AlertChannel } from "./types.js";
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

export const DEFAULT_CHANNELS: Record<string, AlertChannel> = {
    webhook: { send: sendWebhookAlert },
    slack: { send: (target, event) => sendSlackAlert(target, event) },
    pagerduty: { send: (target, event) => sendPagerDutyAlert(target, event) },
    discord: { 
        send: async (target, event) => {
            const { sendDiscordAlert } = await import("./discord.js");
            await sendDiscordAlert(target, event);
        }
    },
    telegram: { 
        send: async (target, event) => {
            const { sendTelegramAlert } = await import("./telegram.js");
            await sendTelegramAlert(target, event);
        }
    },
};

export async function deliverPendingAlerts(
    db: Database.Database,
    network: string,
    channels: Record<string, AlertChannel> = DEFAULT_CHANNELS,
): Promise<DeliveryResult> {
    const pending = getUndeliveredAlerts(db, network);
    const result: DeliveryResult = {
        attempted: 0,
        delivered: 0,
        failed: 0,
        abandoned: 0,
        errors: [],
    };

    if (pending.length === 0) return result;

    logger.debug(`Dispatcher: ${pending.length} undelivered alert(s) for network ${network}`);

    for (const alert of pending) {
        result.attempted++;

        const event = buildAlertEvent({
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

        try {
            const channel = channels[alert.channelType];
            if (!channel) throw new Error(`Unknown channel type: ${alert.channelType}`);
            await channel.send(alert.channelTarget, event, alert.webhookSecret);
            markAlertDelivered(db, alert.alertFiredId);
            result.delivered++;
            logger.info(
                `Alert delivered — id: ${alert.alertFiredId}, channel: ${alert.channelType}, contract: ${alert.contractId}`,
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed++;
            result.errors.push(message);
            incrementRetryCount(db, alert.alertFiredId);
            const nextRetry = alert.retryCount + 1;

            if (nextRetry >= MAX_RETRY_COUNT) {
                result.abandoned++;
                logger.error(
                    `Alert abandoned after ${MAX_RETRY_COUNT} retries — id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`,
                );
            } else {
                logger.warn(
                    `Alert delivery failed (attempt ${nextRetry}/${MAX_RETRY_COUNT}) — id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`,
                );
            }
        }
    }

    logger.debug(
        `Dispatcher finished — attempted: ${result.attempted}, delivered: ${result.delivered}, failed: ${result.failed}, abandoned: ${result.abandoned}`,
    );

    return result;
}

export async function deliverSingleAlert(
    channelType: "webhook" | "slack" | "pagerduty" | "discord" | "telegram",
    channelTarget: string,
    event: AlertEvent,
    webhookSecret?: string | null,
    channels: Record<string, AlertChannel> = DEFAULT_CHANNELS,
): Promise<boolean> {
    try {
        const channel = channels[channelType];
        if (!channel) throw new Error(`Unknown channel type: ${channelType}`);
        await channel.send(channelTarget, event, webhookSecret ?? null);
        return true;
    } catch (error: unknown) {
        logger.warn(`Single alert delivery failed for ${channelType}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
