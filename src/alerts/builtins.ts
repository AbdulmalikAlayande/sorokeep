import { registerAlertChannel, type ChannelDefinition } from "./registry.js";
import { sendWebhookAlert } from "./webhook.js";
import { sendWebhook2Alert } from "./webhook2.js";
import { SlackChannel } from "./slack.js";
import { sendPagerDutyAlert } from "./pagerduty.js";
import { sendOpsgenieAlert } from "./opsgenie.js";
import { sendGoogleChatAlert } from "./googlechat.js";
import { sendSnsAlert } from "./sns.js";

let registered = false;

/**
 * Register sorokeep's five built-in alert channels. Idempotent — safe to
 * call from multiple entry points (dispatcher, CLI) without triggering the
 * registry's duplicate-name guard.
 *
 * Discord and Telegram keep the lazy `await import(...)` pattern they had
 * before the registry existed, so requiring this module doesn't pull in
 * their code paths unless one of those channels is actually used.
 */
export function registerBuiltinChannels(): void {
    if (registered) return;
    registered = true;

    const definitions: ChannelDefinition[] = [
        {
            name: "webhook",
            channel: { send: sendWebhookAlert },
            targetOption: "url",
            missingTargetError: "Error: --url is required when --type is webhook.",
            supportsSigning: true,
        },
        {
            name: "webhook2",
            channel: { send: sendWebhook2Alert },
            targetOption: "url",
            missingTargetError:
                "Error: --url is required when --type is webhook2. The value must be a JSON string: {\"url\":\"https://...\",\"headers\":{},\"timeoutMs\":10000}",
            supportsSigning: true,
        },
        {
            name: "slack",
            channel: { send: (target, event) => new SlackChannel(target).send(event) },
            targetOption: "channel",
            missingTargetError: "Error: --channel is required when --type is slack.",
            supportsSigning: false,
        },
        {
            name: "pagerduty",
            channel: { send: (target, event) => sendPagerDutyAlert(target, event) },
            targetOption: "routingKey",
            missingTargetError: "Error: --routing-key is required when --type is pagerduty.",
            supportsSigning: false,
        },
        {
            name: "googlechat",
            channel: { send: sendGoogleChatAlert },
            targetOption: "url",
            missingTargetError: "Error: --url is required when --type is googlechat.",
            supportsSigning: false,
        },
        {
            name: "sns",
            channel: { send: (target, event) => sendSnsAlert(target, event) },
            targetOption: "url",
            missingTargetError: "Error: --url is required when --type is sns. Paste the full SNS topic ARN.",
            supportsSigning: false,
        },
        {
            name: "discord",
            channel: {
                send: async (target, event) => {
                    const { sendDiscordAlert } = await import("./discord.js");
                    await sendDiscordAlert(target, event);
                },
            },
            targetOption: "url",
            missingTargetError: "Error: --url is required when --type is discord. Paste the full Discord webhook URL.",
            supportsSigning: false,
        },
        {
            name: "telegram",
            channel: {
                send: async (target, event) => {
                    const { sendTelegramAlert } = await import("./telegram.js");
                    await sendTelegramAlert(target, event);
                },
            },
            targetOption: "channel",
            missingTargetError: "Error: --channel is required when --type is telegram (use chat ID or @channelname).",
            supportsSigning: false,
            // Telegram's Bot API rate limits are stricter than a generic webhook's —
            // give up sooner rather than hammering a channel that's already throttling us.
            maxRetries: 3,
        },
        {
            name: "opsgenie",
            channel: { send: (target, event) => sendOpsgenieAlert(target, event) },
            targetOption: "routingKey",
            missingTargetError: "Error: --routing-key is required when --type is opsgenie (use your Opsgenie API key).",
            supportsSigning: false,
        },
        {
            name: "teams",
            channel: {
                send: async (target, event) => {
                    const { sendTeamsAlert } = await import("./teams.js");
                    await sendTeamsAlert(target, event);
                },
            },
            targetOption: "url",
            missingTargetError: "Error: --url is required when --type is teams. Paste the full Teams webhook URL.",
            supportsSigning: false,
        },
        {
            name: "matrix",
            channel: {
                send: async (target, event) => {
                    const { sendMatrixAlert } = await import("./matrix.js");
                    await sendMatrixAlert(target, event);
                },
            },
            targetOption: "channel",
            missingTargetError: "Error: --channel is required when --type is matrix (use the Matrix room ID).",
            supportsSigning: false,
        },
        {
            name: "email",
            channel: {
                send: async (target, event) => {
                    const { sendEmailAlert } = await import("./email.js");
                    await sendEmailAlert(target, event);
                },
            },
            targetOption: "channel",
            missingTargetError: "Error: --channel is required when --type is email (use the recipient email address).",
            supportsSigning: false,
        },
    ];

    for (const def of definitions) {
        registerAlertChannel(def);
    }
}

/** Test-only: allows re-registering builtins after a registry reset. */
export function _resetBuiltinRegistrationForTesting(): void {
    registered = false;
}
