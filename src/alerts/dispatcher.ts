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