import { createHmac } from "node:crypto";
import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "WebhookHandler" });

const TIMEOUT_MS = 10_000;

/**
 * Send an AlertEvent to a webhook URL via HTTP POST.
 *
 * If a `secret` is provided, the request includes an `X-Sentinel-Signature`
 * header with an HMAC-SHA256 hex digest of the body, allowing receivers to
 * verify authenticity.
 *
 * Throws on any non-2xx response or network error.
 * The caller (dispatcher) is responsible for retry logic via the `delivered` flag.
 */
export async function sendWebhookAlert(url: string, event: AlertEvent, secret?: string | null): Promise<void> {
    logger.debug(`Sending webhook alert to ${url}`, { type: event.type, contractId: event.contractId });

    const body = JSON.stringify(event);
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (secret) {
        const signature = createHmac("sha256", secret).update(body).digest("hex");
        headers["X-Sentinel-Signature"] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(
            `Webhook delivery failed: HTTP ${response.status} from ${url}`,
        );
    }

    logger.debug(`Webhook alert delivered successfully to ${url}`);
}
