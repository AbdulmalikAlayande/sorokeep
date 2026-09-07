import type Database from "better-sqlite3";
import { getUndeliveredAlerts, markAlertDelivered, incrementRetryCount, MAX_RETRY_COUNT } from "../db/repositories.js";
import { buildAlertEvent, type AlertEvent, type AlertChannel } from "./types.js";
import { registerBuiltinChannels } from "./builtins.js";
import { listAlertChannels } from "./registry.js";
import { getLogger } from "../logging/index.js";
import { getAlertChannel } from "./registry.js";
import { alertsDeliveredTotal, alertsFailedTotal, alertsAbandonedTotal, alertDeliveryDurationSeconds } from "../observability/metrics/alerts.js";
import "./builtins.js"; // Ensure builtins are registered

const logger = getLogger().child({ component: "AlertDispatcher" });

// Ensure the five built-in channels are registered before any delivery
// function needs to resolve a channel by name. Idempotent.
registerBuiltinChannels();

/**
 * Builds a fresh `{ name: AlertChannel }` map from every channel currently
 * registered (built-ins plus any plugin channels registered by the host
 * application). Used as the default when a caller doesn't inject its own
 * `channels` map — tests inject their own mocked map instead.
 */
function defaultChannels(): Record<string, AlertChannel> {
    return Object.fromEntries(listAlertChannels().map((def) => [def.name, def.channel]));
}

/**
 * Returns the current HH:MM (24-hour) in the given IANA timezone.
 * Falls back to UTC if the timezone string is invalid.
 */
function currentHHMMInTz(timezone: string): string {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).formatToParts(new Date());
        const hour = parts.find((p) => p.type === "hour")!.value;
        const minute = parts.find((p) => p.type === "minute")!.value;
        // Intl may return "24" for midnight in some environments — normalise to "00".
        const normHour = hour === "24" ? "00" : hour;
        return `${normHour}:${minute}`;
    } catch {
        // Unknown timezone — fall back to UTC.
        return new Date().toISOString().slice(11, 16);
    }
}

/**
 * Convert an HH:MM string to total minutes since midnight.
 */
function toMinutes(hhmm: string): number {
    const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
    return hh * 60 + mm;
}

/**
 * Returns true if `current` (HH:MM) falls within the [start, end) window.
 * Handles overnight windows where start > end (e.g. 22:00–06:00).
 */
export function isInQuietHours(
    current: string,
    start: string,
    end: string,
): boolean {
    const c = toMinutes(current);
    const s = toMinutes(start);
    const e = toMinutes(end);

    if (s <= e) {
        // Same-day window: e.g. 09:00–17:00
        return c >= s && c < e;
    } else {
        // Overnight window: e.g. 22:00–06:00
        return c >= s || c < e;
    }
}

export interface DeliveryResult {
    attempted: number;
    delivered: number;
    failed: number;
    abandoned: number;
    errors: string[];
}

export async function deliverPendingAlerts(
    db: Database.Database,
    network: string,
    channels: Record<string, AlertChannel> = defaultChannels(),
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
        const channelDef = getAlertChannel(alert.channelType);
        const maxRetries = channelDef?.maxRetries ?? MAX_RETRY_COUNT;

        if (alert.retryCount >= maxRetries) {
            // Already abandoned in a previous cycle, but DB query still fetched it 
            // because DB uses the global MAX_RETRY_COUNT. Just ignore it.
            continue;
        }

        result.attempted++;

        // ── Quiet-hours check ───────────────────────────────────────────────
        // If the alert's config has a fully-configured quiet window AND the
        // current wall-clock time in the configured timezone falls within it,
        // skip delivery for this cycle.  The alert stays pending (delivered=0,
        // retry_count unchanged) and will be retried on the next daemon cycle.
        if (
            alert.quietHoursStart !== null &&
            alert.quietHoursEnd !== null &&
            alert.quietHoursTimezone !== null
        ) {
            const tz = alert.quietHoursTimezone;
            const currentHHMM = currentHHMMInTz(tz);
            if (isInQuietHours(currentHHMM, alert.quietHoursStart, alert.quietHoursEnd)) {
                logger.debug(
                    `Alert skipped (quiet hours ${alert.quietHoursStart}–${alert.quietHoursEnd} ${tz}) — id: ${alert.alertFiredId}, contract: ${alert.contractId}`,
                );
                // Do NOT mark delivered, do NOT increment retry_count.
                // attempted is still incremented (we did process this alert, just chose to defer it).
                continue;
            }
        }

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

        const deliveryStart = process.hrtime.bigint();
        try {
            const channel = channels[alert.channelType];
            if (!channel) throw new Error(`Unknown channel type: ${alert.channelType}`);
            await channel.send(alert.channelTarget, event, alert.webhookSecret);
            markAlertDelivered(db, alert.alertFiredId);
            result.delivered++;
            alertsDeliveredTotal.inc({ channel_type: alert.channelType });
            logger.info(
                `Alert delivered — id: ${alert.alertFiredId}, channel: ${alert.channelType}, contract: ${alert.contractId}`,
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed++;
            result.errors.push(message);
            alertsFailedTotal.inc({ channel_type: alert.channelType });
            incrementRetryCount(db, alert.alertFiredId);
            const nextRetry = alert.retryCount + 1;

            if (nextRetry >= maxRetries) {
                result.abandoned++;
                alertsAbandonedTotal.inc({ channel_type: alert.channelType });
                logger.error(
                    `Alert abandoned after ${MAX_RETRY_COUNT} retries — id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`,
                );
            } else {
                logger.warn(
                    `Alert delivery failed (attempt ${nextRetry}/${MAX_RETRY_COUNT}) — id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`,
                );
            }
        } finally {
            const durationSeconds = Number(process.hrtime.bigint() - deliveryStart) / 1e9;
            alertDeliveryDurationSeconds.observe({ channel_type: alert.channelType }, durationSeconds);
        }
    }

    logger.debug(
        `Dispatcher finished — attempted: ${result.attempted}, delivered: ${result.delivered}, failed: ${result.failed}, abandoned: ${result.abandoned}`,
    );

    return result;
}

export async function deliverSingleAlert(
    channelType: string,
    channelTarget: string,
    event: AlertEvent,
    webhookSecret?: string | null,
    channels: Record<string, AlertChannel> = defaultChannels(),
): Promise<boolean> {
    const deliveryStart = process.hrtime.bigint();
    try {
        const channel = channels[channelType];
        if (!channel) throw new Error(`Unknown channel type: ${channelType}`);
        await channel.send(channelTarget, event, webhookSecret ?? null);
        alertsDeliveredTotal.inc({ channel_type: channelType });
        return true;
    } catch (error: unknown) {
        alertsFailedTotal.inc({ channel_type: channelType });
        logger.warn(`Single alert delivery failed for ${channelType}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    } finally {
        const durationSeconds = Number(process.hrtime.bigint() - deliveryStart) / 1e9;
        alertDeliveryDurationSeconds.observe({ channel_type: channelType }, durationSeconds);
    }
}
