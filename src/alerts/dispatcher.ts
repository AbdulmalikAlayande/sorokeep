import type Database from "better-sqlite3";
import { getUndeliveredAlerts, markAlertDelivered } from "../db/repositories.js";
import { buildAlertEvent, type AlertEvent } from "./types.js";
import { sendWebhookAlert } from "./webhook.js";
import { sendSlackAlert } from "./slack.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "AlertDispatcher" });

// ─── Public contract ─────────────────────────────────────────────────────────

export interface DeliveryResult {
    /** Total alerts processed (includes email-skipped and failed). */
    attempted: number;
    /** Alerts successfully sent and marked delivered = 1. */
    delivered: number;
    /** Alerts that threw during delivery — left as delivered = 0 for retry. */
    failed: number;
    /** Error messages for each failed delivery. */
    errors: string[];
}

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * Read all undelivered alerts for the given network from the database and
 * dispatch them to the appropriate channel handler.
 *
 * Per-alert errors are caught and collected — this function never throws.
 * Failed deliveries are left with `delivered = 0` so the next daemon cycle
 * retries them automatically.
 *
 * Email channel type is not yet implemented and will be counted as attempted
 * but not delivered or failed.
 */
export async function deliverPendingAlerts(
    db: Database.Database,
    network: string,
): Promise<DeliveryResult> {
    const result: DeliveryResult = {
        attempted: 0,
        delivered: 0,
        failed: 0,
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
            await route(alert.channelType, alert.channelTarget, event);
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

            logger.warn(
                `Alert delivery failed — id: ${alert.alertFiredId}, ` +
                `channel: ${alert.channelType}, error: ${message}. Will retry next cycle.`,
            );
        }
    }

    logger.debug(
        `Dispatcher finished — attempted: ${result.attempted}, ` +
        `delivered: ${result.delivered}, failed: ${result.failed}`,
    );

    return result;
}

// ─── Private ─────────────────────────────────────────────────────────────────

async function route(
    channelType: string,
    channelTarget: string,
    event: AlertEvent,
): Promise<void> {
    switch (channelType) {
        case "webhook":
            await sendWebhookAlert(channelTarget, event);
            break;
        case "slack":
            await sendSlackAlert(channelTarget, event);
            break;
        case "email":
            // Email delivery is not yet implemented.
            // Log and return without marking as delivered or failed.
            logger.debug(`Email delivery not yet implemented — skipping alert to ${channelTarget}`);
            break;
        default:
            throw new Error(`Unknown channel type: ${channelType}`);
    }
}
