import { Command } from "commander";
import chalk from "chalk";
import { randomBytes } from "node:crypto";
import { getDatabase } from "../db/database.js";
import {
    insertAlertConfig,
    getAlertConfigsForContract,
    getAlertConfigById,
    deleteAlertConfig,
    getContract,
    getAlertHistory,
} from "../db/repositories.js";
import { formatContractID, formatTimeToCloseLedger } from "../utils/formatting.js";
import { deliverSingleAlert } from "../alerts/dispatcher.js";
import { buildAlertEvent } from "../alerts/types.js";

export function registerAlertsCommand(program: Command): void {
    const alerts = program
        .command("alerts")
        .description("Manage alert configurations");

    // ── alerts add ─────────────────────────────────────────────────────
    alerts
        .command("add")
        .description("Add a new alert configuration")
        .requiredOption("--contract <id>", "The contract ID to alert on")
        .requiredOption("--type <type>", "The notification channel type ('webhook', 'slack', or 'pagerduty')")
        .option("--url <url>", "Webhook URL (required if --type is webhook)")
        .option("--channel <channel>", "Slack channel (required if --type is slack)")
        .option("--routing-key <key>", "PagerDuty integration key (required if --type is pagerduty)")
        .option("--secret <secret>", "HMAC secret for webhook signing (auto-generated if omitted for webhooks)")
        .requiredOption("--threshold <ledgers>", "Threshold in number of ledgers", (val) => parseInt(val, 10))
        .action((options) => {
            const contractId = options.contract;
            const threshold = options.threshold;

            if (isNaN(threshold) || threshold <= 0) {
                console.error(chalk.red("Error: --threshold must be a positive integer."));
                process.exit(1);
            }

            const db = getDatabase();
            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(chalk.red(`Error: Contract ${formatContractID(contractId)} is not registered.`));
                console.error(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                process.exit(1);
            }

            let target = "";
            let webhookSecret: string | undefined;

            if (options.type === "webhook") {
                if (!options.url) {
                    console.error(chalk.red("Error: --url is required when --type is webhook."));
                    process.exit(1);
                }
                target = options.url;
                webhookSecret = options.secret ?? randomBytes(32).toString("hex");
            } else if (options.type === "slack") {
                if (!options.channel) {
                    console.error(chalk.red("Error: --channel is required when --type is slack."));
                    process.exit(1);
                }
                target = options.channel;
            } else if (options.type === "pagerduty") {
                if (!options.routingKey) {
                    console.error(chalk.red("Error: --routing-key is required when --type is pagerduty."));
                    process.exit(1);
                }
                target = options.routingKey;
            } else if (options.type === "email") {
                console.error(chalk.red("Error: Email alerting is not yet implemented. Use 'webhook', 'slack' or 'pagerduty'."));
                process.exit(1);
            } else {
                console.error(chalk.red("Error: --type must be 'webhook', 'slack', or 'pagerduty'."));
                process.exit(1);
            }

            insertAlertConfig(db, {
                contract_id: contractId,
                channel_type: options.type,
                channel_target: target,
                threshold_ledgers: threshold,
                webhook_secret: webhookSecret,
            });

            console.log(
                chalk.green(
                    `Successfully added alert config: type=${options.type}, target=${target}, threshold=${threshold} ledgers`
                )
            );

            if (webhookSecret) {
                console.log(`  ${chalk.bold("Webhook secret:")} ${webhookSecret}`);
                console.log(chalk.dim("  Save this secret — it signs payloads via X-Sorokeep-Signature header."));
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

    // ── alerts test ────────────────────────────────────────────────────
    alerts
        .command("test")
        .description("Send a test alert to verify channel connectivity")
        .requiredOption("--id <id>", "The alert configuration ID to test")
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

            const testEvent = buildAlertEvent({
                type: "threshold_crossed",
                contractId: config.contract_id,
                contractName: null,
                network: "testnet",
                entryKeyXdr: "TEST_ENTRY_KEY",
                entryType: "instance",
                entryLabel: "test-entry",
                configuredLedgers: config.threshold_ledgers,
                remainingTTL: Math.floor(config.threshold_ledgers * 0.5),
                firedAtLedger: 0,
            });

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
}
