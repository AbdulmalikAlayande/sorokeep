import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "WebhookHandler" });

const TIMEOUT_MS = 10_000;

/**
 * Send an AlertEvent to a webhook URL via HTTP POST.
 *
 * Throws on any non-2xx response or network error.
 * The caller (dispatcher) is responsible for retry logic via the `delivered` flag.
 */
export async function sendWebhookAlert(url: string, event: AlertEvent): Promise<void> {
    logger.debug(`Sending webhook alert to ${url}`, { type: event.type, contractId: event.contractId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}