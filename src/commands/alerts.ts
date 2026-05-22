import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database";
import {
    insertAlertConfig,
    getAlertConfigsForContract,
    deleteAlertConfig,
    getContract,
} from "../db/repositories";
import { formatContractID } from "../utils/formatting";

export function registerAlertsCommand(program: Command): void {
    const alerts = program
        .command("alerts")
        .description("Manage alert configurations");

    alerts
        .command("add")
        .description("Add a new alert configuration")
        .requiredOption("--contract <id>", "The contract ID to alert on")
        .requiredOption("--type <type>", "The notification channel type ('webhook', 'slack', or 'email')")
        .option("--url <url>", "Webhook URL (required if --type is webhook)")
        .option("--channel <channel>", "Slack channel (required if --type is slack)")
        .option("--email <email>", "Email address (required if --type is email)")
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
                console.error(chalk.dim("Run 'sentinel watch <contractId>' first."));
                process.exit(1);
            }

            let target = "";
            if (options.type === "webhook") {
                if (!options.url) {
                    console.error(chalk.red("Error: --url is required when --type is webhook."));
                    process.exit(1);
                }
                target = options.url;
            } else if (options.type === "slack") {
                if (!options.channel) {
                    console.error(chalk.red("Error: --channel is required when --type is slack."));
                    process.exit(1);
                }
                target = options.channel;
            } else if (options.type === "email") {
                if (!options.email) {
                    console.error(chalk.red("Error: --email is required when --type is email."));
                    process.exit(1);
                }
                target = options.email;
            } else {
                console.error(chalk.red("Error: --type must be 'webhook', 'slack', or 'email'."));
                process.exit(1);
            }

            insertAlertConfig(db, {
                contract_id: contractId,
                channel_type: options.type,
                channel_target: target,
                threshold_ledgers: threshold,
            });

            console.log(
                chalk.green(
                    `Successfully added alert config: type=${options.type}, target=${target}, threshold=${threshold} ledgers`
                )
            );
        });

    alerts
        .command("list")
}