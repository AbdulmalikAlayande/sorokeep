import type Database from "better-sqlite3";
import { getUndeliveredAlerts, markAlertDelivered, incrementRetryCount, MAX_RETRY_COUNT } from "../db/repositories.js";
import { buildAlertEvent, type AlertEvent } from "./types.js";
import { sendWebhookAlert } from "./webhook.js";
import { sendSlackAlert } from "./slack.js";
import { sendPagerDutyAlert } from "./pagerduty.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "AlertDispatcher" });

// ─── Public contract ─────────────────────────────────────────────────────────

export interface DeliveryResult {
    /** Total alerts processed (includes failed). */
    attempted: number;
    /** Alerts successfully sent and marked delivered = 1. */
    delivered: number;
    /** Alerts that threw during delivery — retry count incremented. */
    failed: number;
    /** Alerts that exceeded max retries and were abandoned. */
    abandoned: number;
    /** Error messages for each failed delivery. */
    errors: string[];
}

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * Read all undelivered alerts for the given network from the database and
 * dispatch them to the appropriate channel handler.
 *
 * Per-alert errors are caught and collected — this function never throws.
 * Failed deliveries have their retry_count incremented. Alerts exceeding
 * MAX_RETRY_COUNT are excluded from future queries automatically.
 */
export async function deliverPendingAlerts(
    db: Database.Database,
    network: string,
): Promise<DeliveryResult> {
    const result: DeliveryResult = {
        attempted: 0,
        delivered: 0,
        failed: 0,
        abandoned: 0,
        errors: [],
    };

    const pending = getUndeliveredAlerts(db, network);

    if (pending.length === 0) return result;

    logger.debug(`Dispatcher: ${pending.length} undelivered alert(s) for network ${network}`);

    for (const alert of pending) {
        result.attempted++;

        // Build the AlertEvent payload from the joined row.
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
            await route(alert.channelType, alert.channelTarget, event, alert.webhookSecret);
            markAlertDelivered(db, alert.alertFiredId);
            result.delivered++;

            logger.info(
                `Alert delivered — id: ${alert.alertFiredId}, ` +
                `channel: ${alert.channelType}, contract: ${alert.contractId}`,
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
                    `Alert abandoned after ${MAX_RETRY_COUNT} retries — id: ${alert.alertFiredId}, ` +
                    `channel: ${alert.channelType}, error: ${message}`,
                );
            } else {
                logger.warn(
                    `Alert delivery failed (attempt ${nextRetry}/${MAX_RETRY_COUNT}) — ` +
                    `id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`,
                );
            }
        }
    }

    logger.debug(
        `Dispatcher finished — attempted: ${result.attempted}, ` +
        `delivered: ${result.delivered}, failed: ${result.failed}, abandoned: ${result.abandoned}`,
    );

    return result;
}

/**
 * Deliver a single AlertEvent directly (used for resolution notifications).
 * Returns true on success, false on failure.
 */
export async function deliverSingleAlert(
    channelType: string,
    channelTarget: string,
    event: AlertEvent,
    webhookSecret?: string | null,
): Promise<boolean> {
    try {
        await route(channelType, channelTarget, event, webhookSecret ?? null);
        return true;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Resolution alert delivery failed — channel: ${channelType}, error: ${message}`);
        return false;
    }
}

// ─── Private ─────────────────────────────────────────────────────────────────

async function route(
    channelType: string,
    channelTarget: string,
    event: AlertEvent,
    webhookSecret: string | null,
): Promise<void> {
    switch (channelType) {
        case "webhook":
            await sendWebhookAlert(channelTarget, event, webhookSecret);
            break;
        case "slack":
            await sendSlackAlert(channelTarget, event);
            break;
        case "pagerduty":
            await sendPagerDutyAlert(channelTarget, event);
            break;
        default:
            throw new Error(`Unknown channel type: ${channelType}`);
    }
}
