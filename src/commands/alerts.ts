import { Command } from "commander";
import chalk from "chalk";
import { randomBytes } from "node:crypto";
import { getDatabase } from "../db/database.js";
import {
    insertAlertConfig,
    insertAlertConfigBulk,
    getAlertConfigsForContract,
    getAlertConfigById,
    deleteAlertConfig,
    setAlertConfigEnabled,
    updateAlertConfigSecret,
    insertResourceAlertConfig,
    getContract,
    getAlertHistory,
    getChannelDeliveryStats,
    addTargetToAlertConfig,
} from "../db/repositories.js";
import { formatContractID, formatTimeToCloseLedger } from "../utils/formatting.js";
import { deliverSingleAlert } from "../alerts/dispatcher.js";
import { buildAlertEvent } from "../alerts/types.js";
import { renderAlertTemplate } from "../alerts/templates.js";
import { getAlertChannel, listAlertChannels } from "../alerts/registry.js";
import { registerBuiltinChannels } from "../alerts/builtins.js";

registerBuiltinChannels();

function buildTestEvent(contractId: string, thresholdLedgers: number) {
    return buildAlertEvent({
        type: "threshold_crossed",
        contractId,
        contractName: null,
        network: "testnet",
        entryKeyXdr: "TEST_ENTRY_KEY",
        entryType: "instance",
        entryLabel: "test-entry",
        configuredLedgers: thresholdLedgers,
        remainingTTL: Math.floor(thresholdLedgers * 0.5),
        firedAtLedger: 0,
    });
}

export function registerAlertsCommand(program: Command): void {
    const alerts = program
        .command("alerts")
        .description("Manage alert configurations");

    // ── alerts add ─────────────────────────────────────────────────────
    alerts
        .command("add")
        .description("Add a new alert configuration (TTL-based or resource-based)")
        .option("--contract <id>", "The contract ID to alert on (mutually exclusive with --tag)")
        .option("--tag <tag>", "Apply a TTL alert config to all contracts with this tag (mutually exclusive with --contract)")
        .option("--type <type>", "The notification channel type ('webhook', 'slack', 'discord', 'telegram', or 'pagerduty')")
        .option("--url <url>", "Webhook URL (required if --type is webhook or discord)")
        .option("--channel <channel>", "Slack channel (required if --type is slack)")
        .option("--routing-key <key>", "PagerDuty integration key (required if --type is pagerduty)")
        .option("--target <type:target>", "Additional targets (repeatable)", (val, prev: string[]) => prev.concat([val]), [])
        .option("--secret <secret>", "HMAC secret for webhook signing (auto-generated if omitted for webhooks)")
        .option("--threshold <ledgers>", "Threshold in number of ledgers (for TTL-based alerts)", (val) => parseInt(val, 10))
        .option("--cpu-limit <instructions>", "CPU instruction limit for resource alerts (default: 100,000,000)", (val) => parseInt(val, 10))
        .option("--mem-limit <bytes>", "Memory byte limit for resource alerts (default: 50,000,000)", (val) => parseInt(val, 10))
        .option(
            "--quiet-hours <start-end>",
            "Suppress alerts during a maintenance window. Format: HH:MM-HH:MM (24-hour), e.g. '22:00-06:00'. Requires --timezone.",
        )
        .option(
            "--timezone <tz>",
            "IANA timezone name for --quiet-hours interpretation, e.g. 'America/New_York' or 'UTC'.",
        )
        .action((options) => {
            const contractId: string | undefined = options.contract;
            const tag: string | undefined = options.tag;

            if (!contractId && !tag) {
                console.error(chalk.red("Error: You must specify either --contract <id> or --tag <tag>."));
                process.exit(1);
            }
            if (contractId && tag) {
                console.error(chalk.red("Error: --contract and --tag are mutually exclusive."));
                process.exit(1);
            }

            // Determine if this is a TTL alert or resource alert
            const isTTLAlert = typeof options.threshold !== "undefined";
            const isResourceAlert = typeof options.cpuLimit !== "undefined" || typeof options.memLimit !== "undefined";

            if (!isTTLAlert && !isResourceAlert) {
                console.error(chalk.red("Error: You must specify either --threshold (for TTL alerts) or --cpu-limit/--mem-limit (for resource alerts)."));
                process.exit(1);
            }

            if (isTTLAlert && isResourceAlert) {
                console.error(chalk.red("Error: Cannot mix TTL alerts and resource alerts. Use either --threshold or --cpu-limit/--mem-limit, not both."));
                process.exit(1);
            }

            const db = getDatabase();

            // ── --tag bulk path ────────────────────────────────────────────────
            if (tag) {
                if (!isTTLAlert) {
                    console.error(chalk.red("Error: --tag only supports TTL alerts (--threshold). Use --contract for resource alerts."));
                    process.exit(1);
                }

                const primaryType = options.type;
                const channelDef = getAlertChannel(primaryType);
                if (!channelDef) {
                    const known = listAlertChannels().map((d) => d.name).join(", ");
                    console.error(chalk.red(`Error: --type must be one of: ${known}.`));
                    process.exit(1);
                    return;
                }

                const targetValue = (options as Record<string, string | undefined>)[channelDef.targetOption];
                if (!targetValue) {
                    console.error(chalk.red(channelDef.missingTargetError));
                    process.exit(1);
                    return;
                }

                const threshold = options.threshold;
                if (isNaN(threshold) || threshold <= 0) {
                    console.error(chalk.red("Error: --threshold must be a positive integer."));
                    process.exit(1);
                    return;
                }

                const webhookSecret = channelDef.supportsSigning
                    ? (options.secret ?? randomBytes(32).toString("hex"))
                    : undefined;

                const count = insertAlertConfigBulk(db, tag, {
                    channel_type: primaryType,
                    channel_target: targetValue,
                    threshold_ledgers: threshold,
                    webhook_secret: webhookSecret,
                });

                if (count === 0) {
                    console.log(chalk.yellow(`No contracts found with tag "${tag}". No alert configs created.`));
                    return;
                }

                console.log(
                    chalk.green(
                        `Successfully added alert config to ${count} contract(s) with tag "${tag}": type=${primaryType}, target=${targetValue}, threshold=${threshold} ledgers`,
                    ),
                );

                if (webhookSecret) {
                    console.log(`  ${chalk.bold("Webhook secret:")} ${webhookSecret}`);
                    console.log(chalk.dim("  Save this secret — it signs payloads via X-Sorokeep-Signature header."));
                }
                return;
            }

            // ── --contract single path ─────────────────────────────────────────
            const contract = getContract(db, contractId!);
            if (!contract) {
                console.error(chalk.red(`Error: Contract ${formatContractID(contractId!)} is not registered.`));
                console.error(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                process.exit(1);
            }

            let primaryType = options.type;
            let primaryTarget = "";
            let webhookSecret: string | undefined;

            const additionalTargets: { type: string; target: string }[] = [];
            if (options.target) {
                for (const t of options.target as string[]) {
                    const parts = t.split(":");
                    if (parts.length < 2) {
                        console.error(chalk.red(`Error: --target must be formatted as <type>:<target> (e.g. webhook:https://...). Got: ${t}`));
                        process.exit(1);
                    }
                    const ctype = parts[0]!;
                    const ctarget = parts.slice(1).join(":");

                    const cdef = getAlertChannel(ctype);
                    if (!cdef) {
                        console.error(chalk.red(`Error: Unknown channel type '${ctype}' in --target ${t}`));
                        process.exit(1);
                    }
                    additionalTargets.push({ type: ctype, target: ctarget });
                }
            }

            if (!primaryType) {
                if (additionalTargets.length === 0) {
                    console.error(chalk.red("Error: You must specify either --type and a target flag (e.g., --url) or provide at least one --target <type>:<target> pair."));
                    process.exit(1);
                }
                const first = additionalTargets.shift()!;
                primaryType = first.type;
                primaryTarget = first.target;

                const channelDef = getAlertChannel(primaryType);
                if (channelDef?.supportsSigning) {
                    webhookSecret = options.secret ?? randomBytes(32).toString("hex");
                }
            } else {
                const channelDef = getAlertChannel(primaryType);
                if (!channelDef) {
                    const known = listAlertChannels().map((d) => d.name).join(", ");
                    console.error(chalk.red(`Error: --type must be one of: ${known}.`));
                    process.exit(1);
                } else {
                    const targetValue = (options as Record<string, string | undefined>)[channelDef.targetOption];
                    if (!targetValue) {
                        console.error(chalk.red(channelDef.missingTargetError));
                        process.exit(1);
                    }
                    primaryTarget = targetValue as string;

                    if (channelDef.supportsSigning) {
                        webhookSecret = options.secret ?? randomBytes(32).toString("hex");
                    }
                }
            }

            if (isTTLAlert) {
                const threshold = options.threshold;
                if (isNaN(threshold) || threshold <= 0) {
                    console.error(chalk.red("Error: --threshold must be a positive integer."));
                    process.exit(1);
                }

                // ── Quiet-hours / timezone validation ──────────────────────────
                let quietHoursStart: string | undefined;
                let quietHoursEnd: string | undefined;
                let quietHoursTimezone: string | undefined;

                if (options.quietHours || options.timezone) {
                    if (!options.quietHours || !options.timezone) {
                        console.error(chalk.red("Error: --quiet-hours and --timezone must be used together."));
                        process.exit(1);
                    }

                    // Validate HH:MM-HH:MM format.
                    const qhMatch = (options.quietHours as string).match(
                        /^(\d{2}:\d{2})-(\d{2}:\d{2})$/,
                    );
                    if (!qhMatch) {
                        console.error(chalk.red("Error: --quiet-hours must be in HH:MM-HH:MM format, e.g. '22:00-06:00'."));
                        process.exit(1);
                    }

                    // Validate IANA timezone.
                    try {
                        new Intl.DateTimeFormat("en-US", { timeZone: options.timezone });
                    } catch {
                        console.error(chalk.red(`Error: --timezone '${options.timezone}' is not a valid IANA timezone name.`));
                        process.exit(1);
                    }

                    quietHoursStart = qhMatch[1];
                    quietHoursEnd = qhMatch[2];
                    quietHoursTimezone = options.timezone as string;
                }

                const alertConfigId = insertAlertConfig(db, {
                    contract_id: contractId!,
                    channel_type: primaryType,
                    channel_target: primaryTarget,
                    threshold_ledgers: threshold,
                    webhook_secret: webhookSecret,
                    quiet_hours_start: quietHoursStart,
                    quiet_hours_end: quietHoursEnd,
                    quiet_hours_timezone: quietHoursTimezone,
                });

                for (const extra of additionalTargets) {
                    addTargetToAlertConfig(db, alertConfigId, extra.type, extra.target);
                }

                let successMsg = `Successfully added alert config: type=${primaryType}, target=${primaryTarget}, threshold=${threshold} ledgers`;
                if (additionalTargets.length > 0) {
                    successMsg += `, +${additionalTargets.length} additional target(s)`;
                }
                if (quietHoursStart) {
                    successMsg += `, quiet hours=${quietHoursStart}-${quietHoursEnd} (${quietHoursTimezone})`;
                }
                console.log(chalk.green(successMsg));

                if (webhookSecret) {
                    console.log(`  ${chalk.bold("Webhook secret:")} ${webhookSecret}`);
                    console.log(chalk.dim("  Save this secret — it signs payloads via X-Sorokeep-Signature header."));
                }
            } else {
                // Resource alert
                const cpuLimit = options.cpuLimit ?? 100_000_000;
                const memLimit = options.memLimit ?? 50_000_000;

                if (cpuLimit <= 0 || memLimit <= 0) {
                    console.error(chalk.red("Error: --cpu-limit and --mem-limit must be positive integers."));
                    process.exit(1);
                }

                insertResourceAlertConfig(db, {
                    contract_id: contractId!,
                    channel_type: primaryType,
                    channel_target: primaryTarget,
                    cpu_limit: cpuLimit,
                    mem_limit: memLimit,
                    webhook_secret: webhookSecret,
                });

                // Resource alerts don't currently support multiple targets in schema, but we can log that we aren't supporting it if there are additional targets, 
                // or just leave them since the issue only requested it for standard alert_configs.
                if (additionalTargets.length > 0) {
                    console.log(chalk.yellow("Warning: Additional targets are currently only supported for TTL alerts, not resource alerts."));
                }

                console.log(
                    chalk.green(
                        `Successfully added alert config: type=${primaryType}, target=${primaryTarget}, CPU=${cpuLimit.toLocaleString()} instr, MEM=${memLimit.toLocaleString()} bytes`
                    )
                );

                if (webhookSecret) {
                    console.log(`  ${chalk.bold("Webhook secret:")} ${webhookSecret}`);
                    console.log(chalk.dim("  Save this secret — it signs payloads via X-Sorokeep-Signature header."));
                }
            }
        });

    // ── alerts list ────────────────────────────────────────────────────
    alerts
        .command("list")
        .description("List alert configurations for a contract")
        .requiredOption("--contract <id>", "The contract ID to list alerts for")
        .action((options) => {
            const contractId = options.contract;
            const db = getDatabase();

            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(chalk.red(`Error: Contract ${formatContractID(contractId)} is not registered.`));
                process.exit(1);
            }

            const configs = getAlertConfigsForContract(db, contractId);
            if (configs.length === 0) {
                console.log(chalk.yellow(`No alert configurations found for contract ${formatContractID(contractId)}.`));
                return;
            }

            console.log();
            console.log(chalk.bold(`  Alert Configurations for ${contract.name ?? formatContractID(contractId)}`));
            console.log();
            for (const config of configs) {
                const signed = config.webhook_secret ? chalk.green(" [signed]") : "";
                console.log(
                    `  ID: ${chalk.cyan(config.id.toString().padEnd(4))} | ` +
                    `Type: ${chalk.yellow(config.channel_type.padEnd(8))} | ` +
                    `Target: ${chalk.green(config.channel_target.padEnd(30))} | ` +
                    `Threshold: ${chalk.magenta(config.threshold_ledgers.toLocaleString())} ledgers` +
                    signed
                );
            }
            console.log();
        });

    // ── alerts channels ────────────────────────────────────────────────
    alerts
        .command("channels")
        .description("List all registered alert channel plugins")
        .action(() => {
            const channels = listAlertChannels();

            if (channels.length === 0) {
                console.log(chalk.yellow("No alert channels are registered."));
                return;
            }

            console.log();
            console.log(chalk.bold("  Registered Alert Channels"));
            console.log();
            for (const channel of channels) {
                console.log(
                    `  Name: ${chalk.cyan(channel.name.padEnd(12))} | ` +
                    `Target: ${chalk.yellow(channel.targetOption.padEnd(10))} | ` +
                    `Signing: ${chalk.green(channel.supportsSigning ? "yes" : "no")}`
                );
            }
            console.log();
        });

    // ── alerts remove ──────────────────────────────────────────────────
    alerts
        .command("remove")
        .description("Remove an alert configuration")
        .requiredOption("--id <id>", "The alert configuration ID to remove")
        .action((options) => {
            const id = parseInt(options.id, 10);
            if (isNaN(id)) {
                console.error(chalk.red("Error: --id must be a number."));
                process.exit(1);
            }

            const db = getDatabase();
            deleteAlertConfig(db, id);
            console.log(chalk.green(`Successfully removed alert config ID ${id}.`));
        });

    // ── alerts enable ──────────────────────────────────────────────────
    alerts
        .command("enable")
        .description("Re-enable a previously disabled alert configuration")
        .requiredOption("--id <id>", "The alert configuration ID to enable")
        .action((options) => {
            const id = parseInt(options.id, 10);
            if (isNaN(id)) {
                console.error(chalk.red("Error: --id must be a number."));
                process.exit(1);
            }

            const db = getDatabase();
            const config = getAlertConfigById(db, id);
            if (!config) {
                console.error(chalk.red(`Error: Alert config ID ${id} not found.`));
                process.exit(1);
            }

            setAlertConfigEnabled(db, id, true);
            console.log(chalk.green(`Alert config ID ${id} enabled.`));
        });

    // ── alerts disable ─────────────────────────────────────────────────
    alerts
        .command("disable")
        .description("Disable an alert configuration without deleting it")
        .requiredOption("--id <id>", "The alert configuration ID to disable")
        .action((options) => {
            const id = parseInt(options.id, 10);
            if (isNaN(id)) {
                console.error(chalk.red("Error: --id must be a number."));
                process.exit(1);
            }

            const db = getDatabase();
            const config = getAlertConfigById(db, id);
            if (!config) {
                console.error(chalk.red(`Error: Alert config ID ${id} not found.`));
                process.exit(1);
            }

            setAlertConfigEnabled(db, id, false);
            console.log(chalk.green(`Alert config ID ${id} disabled.`));
        });

    // ── alerts test ────────────────────────────────────────────────────
    alerts
        .command("test")
        .description("Send a test alert to verify channel connectivity")
        .requiredOption("--id <id>", "The alert configuration ID to test")
        .option("--dry-run", "Print the exact payload and do not call the delivery function")
        .action(async (options) => {
            const id = parseInt(options.id, 10);
            if (isNaN(id)) {
                console.error(chalk.red("Error: --id must be a number."));
                process.exit(1);
            }

            const db = getDatabase();
            const config = getAlertConfigById(db, id);
            if (!config) {
                console.error(chalk.red(`Error: Alert config ID ${id} not found.`));
                process.exit(1);
            }

            const testEvent = buildTestEvent(config.contract_id, config.threshold_ledgers);

            if (options.dryRun) {
                if (config.channel_type === "webhook") {
                    const customMessage = renderAlertTemplate("webhook", testEvent);
                    let body: string;
                    if (customMessage !== null) {
                        body = customMessage;
                    } else {
                        body = JSON.stringify(testEvent);
                    }

                    if (config.webhook_secret) {
                        const { createHmac } = await import("node:crypto");
                        const signature = createHmac("sha256", config.webhook_secret).update(body).digest("hex");
                        console.log(`X-Sorokeep-Signature: sha256=${signature}`);
                    }
                    console.log(body);
                } else {
                    console.log(JSON.stringify(testEvent));
                }
                return;
            }

            console.log(`Sending test alert to ${config.channel_type}:${config.channel_target}...`);

            const success = await deliverSingleAlert(
                config.channel_type,
                config.channel_target,
                testEvent,
                config.webhook_secret,
            );

            if (success) {
                console.log(chalk.green("Test alert delivered successfully."));
            } else {
                console.error(chalk.red("Test alert delivery failed. Check logs for details."));
                process.exit(1);
            }
        });

    // ── alerts test-all ────────────────────────────────────────────────
    alerts
        .command("test-all")
        .description("Send test alerts to every configured channel for a contract")
        .requiredOption("--contract <id>", "The contract ID to test alerts for")
        .action(async (options) => {
            const contractId = options.contract;
            const db = getDatabase();

            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(chalk.red(`Error: Contract ${formatContractID(contractId)} is not registered.`));
                process.exit(1);
            }

            const configs = getAlertConfigsForContract(db, contractId);
            if (configs.length === 0) {
                console.log(chalk.yellow(`No alert configurations found for contract ${formatContractID(contractId)}.`));
                return;
            }

            const results: Array<{ channelType: string; target: string; success: boolean; }> = [];

            for (const config of configs) {
                const testEvent = buildTestEvent(config.contract_id, config.threshold_ledgers);
                console.log(`Sending test alert to ${config.channel_type}:${config.channel_target}...`);

                const success = await deliverSingleAlert(
                    config.channel_type,
                    config.channel_target,
                    testEvent,
                    config.webhook_secret,
                );

                results.push({
                    channelType: config.channel_type,
                    target: config.channel_target,
                    success,
                });
            }

            console.log();
            console.log(chalk.bold(`  Alert Connectivity Summary for ${contract.name ?? formatContractID(contractId)}`));
            console.log();
            for (const result of results) {
                console.log(
                    `  Type: ${chalk.cyan(result.channelType.padEnd(10))} | ` +
                    `Target: ${chalk.yellow(result.target.padEnd(30))} | ` +
                    `Status: ${result.success ? chalk.green("success") : chalk.red("failure")}`
                );
            }
            console.log();

            const failedCount = results.filter((result) => !result.success).length;
            if (failedCount > 0) {
                console.error(chalk.red(`${failedCount} channel(s) failed connectivity testing.`));
                process.exit(1);
            }
        });

    // ── alerts history ─────────────────────────────────────────────────
    alerts
        .command("history")
        .description("Show alert history for a contract")
        .requiredOption("--contract <id>", "The contract ID to show history for")
        .option("--limit <n>", "Max number of records to show", "20")
        .action((options) => {
            const contractId = options.contract;
            const limit = parseInt(options.limit, 10);
            const db = getDatabase();

            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(chalk.red(`Error: Contract ${formatContractID(contractId)} is not registered.`));
                process.exit(1);
            }

            const history = getAlertHistory(db, contractId, limit > 0 ? limit : undefined);
            if (history.length === 0) {
                console.log(chalk.yellow("No alert history found."));
                return;
            }

            const displayName = contract.name ?? formatContractID(contractId);
            console.log(`\n${chalk.bold("Alert History")} — ${chalk.cyan(displayName)}\n`);

            for (const record of history) {
                const statusIcon = record.resolved ? chalk.green("✓") : chalk.yellow("●");
                const deliveryIcon = record.delivered ? chalk.green("✓") : chalk.red("✗");
                const label = record.entryLabel ?? record.entryType;
                const ttlDisplay = formatTimeToCloseLedger(record.ttlAtFire);

                console.log(
                    `  ${statusIcon} ${chalk.dim(record.firedAt)} | ` +
                    `${label} | TTL: ${record.ttlAtFire.toLocaleString()} (${ttlDisplay}) | ` +
                    `${record.channelType}→${deliveryIcon} | ` +
                    `retries: ${record.retryCount}`
                );
                if (record.resolvedAt) {
                    console.log(chalk.dim(`    Resolved: ${record.resolvedAt}`));
                }
            }
            console.log();
        });

    // ── alerts stats ───────────────────────────────────────────────────
    alerts
        .command("stats")
        .description("View delivery stats and success rates for an alert channel")
        .requiredOption("--type <type>", "The notification channel type (e.g., webhook, slack)")
        .option("--days <days>", "Number of days to look back (default: all time)", (val) => parseInt(val, 10))
        .action((options) => {
            const db = getDatabase();

            const stats = getChannelDeliveryStats(db, options.type, options.days);

            console.log(`\n${chalk.bold("Delivery Stats")} — ${chalk.cyan(options.type)}`);
            if (options.days) {
                console.log(chalk.dim(`Over the last ${options.days} days`));
            }
            console.log();
            console.log(`  Total Attempts: ${stats.totalAttempts}`);
            console.log(`  Delivered:      ${chalk.green(stats.deliveredCount)}`);
            console.log(`  Failed:         ${chalk.yellow(stats.failedCount)}`);
            console.log(`  Abandoned:      ${chalk.red(stats.abandonedCount)}`);
            console.log();

            const rateColor = stats.successRate >= 90 ? chalk.green : (stats.successRate >= 50 ? chalk.yellow : chalk.red);
            console.log(`  Success Rate:   ${rateColor(stats.successRate.toFixed(1))}%`);
            console.log();
        });

    // ── alerts rotate-secret ───────────────────────────────────────────
    alerts
        .command("rotate-secret")
        .description("Rotate the HMAC signing secret for a webhook alert config")
        .requiredOption("--id <id>", "The alert configuration ID whose secret should be rotated")
        .action((options) => {
            const id = parseInt(options.id, 10);
            if (isNaN(id)) {
                console.error(chalk.red("Error: --id must be a number."));
                process.exit(1);
            }

            const db = getDatabase();
            const config = getAlertConfigById(db, id);
            if (!config) {
                console.error(chalk.red(`Error: Alert config ID ${id} not found.`));
                process.exit(1);
            }

            const channelDef = getAlertChannel(config.channel_type);
            if (!channelDef?.supportsSigning) {
                console.error(
                    chalk.red(
                        `Error: Alert config ID ${id} uses channel type '${config.channel_type}', which does not support HMAC signing. Only webhook channels use a shared secret.`,
                    ),
                );
                process.exit(1);
            }

            const newSecret = randomBytes(32).toString("hex");
            updateAlertConfigSecret(db, id, newSecret);

            console.log(chalk.green(`Successfully rotated secret for alert config ID ${id}.`));
            console.log(`  ${chalk.bold("Webhook secret:")} ${newSecret}`);
            console.log(chalk.dim("  Save this secret — it signs payloads via X-Sorokeep-Signature header."));
        });
}
