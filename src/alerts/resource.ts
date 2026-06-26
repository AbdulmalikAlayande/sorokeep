import type Database from "better-sqlite3";
import {
    getResourceAlertConfigsForContract,
    recordResourceAlertFired,
    hasUnresolvedResourceAlert,
    getUndeliveredResourceAlerts,
    markResourceAlertDelivered,
    incrementResourceAlertRetryCount,
} from "../db/repositories.js";
import { buildResourceAlertEvent, type ResourceAlertEvent } from "./types.js";
import { deliverSingleAlert } from "./dispatcher.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "ResourceAlerts" });

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check transaction resource usage against configured limits and dispatch alerts.
 *
 * @param db Database connection
 * @param contractId Contract ID to check
 * @param resourceData Resource usage data (CPU instructions, memory bytes)
 */
export function checkResourceLimitsAndAlert(
    db: Database.Database,
    contractId: string,
    resourceData: {
        cpuInstructions: number;
        memoryBytes: number;
    }
): void {
    const configs = getResourceAlertConfigsForContract(db, contractId);

    if (configs.length === 0) {
        // No resource alert configs for this contract
        return;
    }

    // Get contract info for alert event building
    const contract = db.prepare("SELECT id, name, network FROM contracts WHERE id = ?").get(contractId) as
        | { id: string; name: string | null; network: string }
        | undefined;

    if (!contract) {
        return;
    }

    for (const config of configs) {
        // Check CPU
        if (resourceData.cpuInstructions > 0) {
            checkAndDispatchResourceAlert(db, {
                config,
                contract,
                resourceType: "cpu",
                currentUsage: resourceData.cpuInstructions,
                limit: config.cpu_limit,
            });
        }

        // Check Memory
        if (resourceData.memoryBytes > 0) {
            checkAndDispatchResourceAlert(db, {
                config,
                contract,
                resourceType: "memory",
                currentUsage: resourceData.memoryBytes,
                limit: config.mem_limit,
            });
        }
    }
}

/**
 * Check if a resource alert should be dispatched and handle it.
 */
function checkAndDispatchResourceAlert(
    db: Database.Database,
    opts: {
        config: {
            id: number;
            contract_id: string;
            channel_type: "slack" | "webhook";
            channel_target: string;
            webhook_secret: string | null;
            cpu_limit: number;
            mem_limit: number;
        };
        contract: { id: string; name: string | null; network: string };
        resourceType: "cpu" | "memory";
        currentUsage: number;
        limit: number;
    }
): void {
    const usagePercent = Math.floor((opts.currentUsage / opts.limit) * 100);

    // Only alert if usage exceeds 80% threshold
    if (usagePercent < 80) {
        return;
    }

    // Check if there's already an unresolved alert for this resource type
    // If the previous unresolved alert had an equal or higher usage percent,
    // skip creating a duplicate. If usage increased, allow a new alert.
    if (hasUnresolvedResourceAlert(db, opts.config.id, opts.resourceType, usagePercent)) {
        logger.debug(
            `Skipping duplicate alert for ${opts.resourceType} on contract ${opts.contract.id} (already has unresolved alert)`
        );
        return;
    }

    // Record the alert in the database
    const alertFiredId = recordResourceAlertFired(db, {
        resource_alert_config_id: opts.config.id,
        resource_type: opts.resourceType,
        usage: opts.currentUsage,
        limit: opts.limit,
        usage_percent: usagePercent,
    });

    logger.info(
        `Resource alert recorded: ${opts.resourceType}=${usagePercent}% on ${opts.contract.id} (alert ID: ${alertFiredId})`
    );

    // Build the alert event
    const event = buildResourceAlertEvent({
        contractId: opts.contract.id,
        contractName: opts.contract.name,
        network: opts.contract.network,
        resourceType: opts.resourceType,
        currentUsage: opts.currentUsage,
        limit: opts.limit,
        usagePercent,
    });

    // Dispatch immediately
    void dispatchResourceAlert(opts.config, event, alertFiredId, db);
}

/**
 * Dispatch a resource alert to the configured channel.
 */
async function dispatchResourceAlert(
    config: {
        id: number;
        channel_type: "slack" | "webhook";
        channel_target: string;
        webhook_secret: string | null;
    },
    event: ResourceAlertEvent,
    alertFiredId: number,
    db: Database.Database
): Promise<void> {
    try {
        const success = await deliverSingleAlert(config.channel_type, config.channel_target, event, config.webhook_secret);

        if (success) {
            markResourceAlertDelivered(db, alertFiredId);
            logger.info(`Resource alert delivered: ID ${alertFiredId}`);
        } else {
            incrementResourceAlertRetryCount(db, alertFiredId);
            logger.warn(`Resource alert delivery failed, will retry: ID ${alertFiredId}`);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        incrementResourceAlertRetryCount(db, alertFiredId);
        logger.error(`Error dispatching resource alert ID ${alertFiredId}: ${message}`);
    }
}

/**
 * Process all pending resource alerts for delivery (called by daemon).
 */
export async function deliverPendingResourceAlerts(
    db: Database.Database,
    network: string
): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
    abandoned: number;
    errors: string[];
}> {
    const result = {
        attempted: 0,
        delivered: 0,
        failed: 0,
        abandoned: 0,
        errors: [] as string[],
    };

    const pending = getUndeliveredResourceAlerts(db, network);

    if (pending.length === 0) {
        return result;
    }

    logger.debug(`Resource alert dispatcher: ${pending.length} undelivered alert(s) for network ${network}`);

    for (const alert of pending) {
        result.attempted++;

        const event = buildResourceAlertEvent({
            contractId: alert.contractId,
            contractName: alert.contractName,
            network: alert.network,
            resourceType: alert.resourceType,
            currentUsage: alert.usage,
            limit: alert.limit,
            usagePercent: alert.usagePercent,
            firedAtLedger: alert.firedAtLedger ?? undefined,
        });

        try {
            const success = await deliverSingleAlert(alert.channelType, alert.channelTarget, event, alert.webhookSecret);

            if (success) {
                markResourceAlertDelivered(db, alert.alertFiredId);
                result.delivered++;
                logger.info(
                    `Resource alert delivered — id: ${alert.alertFiredId}, ` +
                    `channel: ${alert.channelType}, contract: ${alert.contractId}`
                );
            } else {
                throw new Error("Delivery returned false");
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed++;
            result.errors.push(message);

            incrementResourceAlertRetryCount(db, alert.alertFiredId);
            const nextRetry = alert.retryCount + 1;

            // Check if max retries exceeded
            if (nextRetry >= 5) {
                result.abandoned++;
                logger.error(
                    `Resource alert abandoned after 5 retries — id: ${alert.alertFiredId}, ` +
                    `channel: ${alert.channelType}, error: ${message}`
                );
            } else {
                logger.warn(
                    `Resource alert delivery failed (attempt ${nextRetry}/5) — ` +
                    `id: ${alert.alertFiredId}, channel: ${alert.channelType}, error: ${message}`
                );
            }
        }
    }

    return result;
}
