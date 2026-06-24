import nodemailer from "nodemailer";
import type { AlertEvent } from "./types.js";
import type { SmtpConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "EmailHandler" });

// ─── HTML template ────────────────────────────────────────────────────────────

function buildSubject(event: AlertEvent): string {
    const contract = event.contractName ?? event.contractId;
    if (event.type === "alert_resolved") {
        return `[Sorokeep] Alert Resolved — ${contract}`;
    }
    const severity = event.severity === "critical" ? "CRITICAL" : "Warning";
    return `[Sorokeep] TTL ${severity} — ${contract}`;
}

function buildHtml(event: AlertEvent): string {
    const contract = event.contractName ?? event.contractId;
    const statusLabel = event.type === "alert_resolved"
        ? "Alert Resolved ✅"
        : event.severity === "critical" ? "TTL Critical 🔴" : "TTL Warning ⚠️";

    return `<div style="font-family:sans-serif;max-width:600px">
  <h2>${statusLabel}</h2>
  <table style="border-collapse:collapse;width:100%">
    <tr><th align="left">Contract</th><td>${contract}</td></tr>
    <tr><th align="left">Network</th><td>${event.network}</td></tr>
    <tr><th align="left">Entry</th><td>${event.entry.label ?? event.entry.type}</td></tr>
    <tr><th align="left">Remaining TTL</th><td>${event.threshold.currentRemainingLedgers.toLocaleString()} ledgers (${event.threshold.approximateTimeRemaining})</td></tr>
    <tr><th align="left">Threshold</th><td>${event.threshold.configuredLedgers.toLocaleString()} ledgers</td></tr>
    <tr><th align="left">Severity</th><td>${event.severity}</td></tr>
    <tr><th align="left">Timestamp</th><td>${event.timestamp}</td></tr>
  </table>
  <p style="color:#888;font-size:12px">Run <code>sorokeep status ${event.contractId}</code> for details.</p>
</div>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an AlertEvent to a recipient email address via SMTP using nodemailer.
 *
 * Throws on config validation errors, transport failures, or delivery errors.
 * The caller (dispatcher) handles retry via the `delivered` flag.
 */
export async function sendEmailAlert(
    recipient: string,
    event: AlertEvent,
    smtp: SmtpConfig,
): Promise<void> {
    if (!recipient) {
        throw new Error("Email recipient address is required");
    }
    if (!smtp.host) {
        throw new Error("SMTP host is required");
    }

    logger.debug(`Sending email alert to ${recipient}`, { type: event.type, contractId: event.contractId });

    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        auth: { user: smtp.user, pass: smtp.password },
    });

    await transporter.sendMail({
        from: smtp.from,
        to: recipient,
        subject: buildSubject(event),
        html: buildHtml(event),
    });

    logger.debug(`Email alert delivered successfully to ${recipient}`);
}
