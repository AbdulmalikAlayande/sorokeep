import { createHmac, timingSafeEqual } from "node:crypto";
import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";
import { renderAlertTemplate } from "./templates.js";
import { getStellarExpertContractUrl } from "./links.js";

const logger = getLogger().child({ component: "WebhookHandler" });

const TIMEOUT_MS = 10_000;

/**
 * Verify an incoming webhook HMAC-SHA256 signature.
 *
 * @param payload The raw request body string received by the webhook endpoint.
 * @param signature The signature header string (e.g. `X-Sorokeep-Signature`), with or without `sha256=` prefix.
 * @param secret The webhook signing secret.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!payload || !signature || !secret) {
        return false;
    }

    const cleanSignature = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");

    const sigBuffer = Buffer.from(cleanSignature);
    const expectedBuffer = Buffer.from(expectedHex);

    if (sigBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Send an AlertEvent to a webhook URL via HTTP POST.
 *
 * If a `secret` is provided, the request includes an `X-Sorokeep-Signature`
 * header with an HMAC-SHA256 hex digest of the body, allowing receivers to
 * verify authenticity.
 *
 * Throws on any non-2xx response or network error.
 * The caller (dispatcher) is responsible for retry logic via the `delivered` flag.
 */
export async function sendWebhookAlert(url: string, event: AlertEvent, secret?: string | null): Promise<void> {
    logger.debug(`Sending webhook alert to ${url}`, { type: event.type, contractId: event.contractId });

    const customMessage = renderAlertTemplate("webhook", event);
    let body: string;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (customMessage !== null) {
        body = customMessage;
        try {
            JSON.parse(customMessage);
        } catch {
            headers["Content-Type"] = "text/plain";
        }
    } else {
        const stellarExpertUrl = getStellarExpertContractUrl(event);
        body = JSON.stringify(stellarExpertUrl ? { ...event, stellarExpertUrl } : event);
    }

    if (secret) {
        const signature = createHmac("sha256", secret).update(body).digest("hex");
        headers["X-Sorokeep-Signature"] = `sha256=${signature}`;
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
