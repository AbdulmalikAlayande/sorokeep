import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "PagerDutyHandler" });
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const TIMEOUT_MS = 10_000;

type PagerDutySeverity = "critical" | "error" | "warning" | "info";

function mapSeverity(event: AlertEvent): PagerDutySeverity {
    if (event.type === "alert_resolved") return "info";
    return event.severity === "critical" ? "critical" : "warning";
}

function buildDedupKey(event: AlertEvent): string {
    const entryKey = event.entry.keyXdr || event.entry.type;
    return `sorokeep:${event.network}:${event.contractId}:${entryKey}:${event.threshold.configuredLedgers}`;
}

function buildSummary(event: AlertEvent): string {
    const contractDisplay = event.contractName ?? event.contractId;

    if (event.type === "threshold_crossed") {
        return `Sorokeep alert: ${contractDisplay} has crossed the TTL threshold (${event.threshold.currentRemainingLedgers} ledgers remaining).`;
    }

    return `Sorokeep alert resolved: ${contractDisplay} has recovered above threshold.`;
}

function buildPayload(event: AlertEvent): unknown {
    return {
        routing_key: "",
        event_action: event.type === "threshold_crossed" ? "trigger" : "resolve",
        dedup_key: buildDedupKey(event),
        payload: {
            summary: buildSummary(event),
            source: event.contractId,
            severity: mapSeverity(event),
            component: event.entry.label ?? event.entry.type,
            group: event.network,
            class: `threshold:${event.threshold.configuredLedgers}`,
            custom_details: {
                contractId: event.contractId,
                contractName: event.contractName,
                network: event.network,
                entryKeyXdr: event.entry.keyXdr,
                entryType: event.entry.type,
                entryLabel: event.entry.label,
                currentRemainingLedgers: event.threshold.currentRemainingLedgers,
                configuredLedgers: event.threshold.configuredLedgers,
                approximateTimeRemaining: event.threshold.approximateTimeRemaining,
                firedAtLedger: event.firedAtLedger,
                timestamp: event.timestamp,
            },
        },
    };
}

export class PagerDutyChannel {
    #routingKey: string;

    constructor(routingKey: string) {
        if (!routingKey || routingKey.trim() === "") {
            throw new Error("PagerDuty routing key is required.");
        }
        this.#routingKey = routingKey;
    }

    public async send(event: AlertEvent): Promise<void> {
        logger.debug(`Sending PagerDuty event: ${event.type}`, { contractId: event.contractId });

        const payload = buildPayload(event) as Record<string, unknown>;
        payload.routing_key = this.#routingKey;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(PAGERDUTY_EVENTS_URL, {
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

        if (!response.ok) {
            throw new Error(`PagerDuty API request failed: HTTP ${response.status}`);
        }

        logger.debug(`PagerDuty event delivered successfully: ${event.type}`);
    }
}

export async function sendPagerDutyAlert(routingKey: string, event: AlertEvent): Promise<void> {
    const channel = new PagerDutyChannel(routingKey);
    await channel.send(event);
}
