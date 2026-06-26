import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getChannelAccounts } from "../db/repositories.js";
import { addChannel, fundChannels } from "../core/channels.js";
import { formatContractID } from "../utils/formatting.js";

export function registerChannelsCommand(program: Command): void {
    const channels = program
        .command("channels")
        .description("Manage channel accounts for fee bumping and transaction parallelism");

    // ── channels add ────────────────────────────────────────────────────────
    channels
        .command("add")
        .description("Register a channel account public key")
        .requiredOption("--key <publicKey>", "Stellar public key of the channel account")
        .option("--label <label>", "Optional human-readable label")
        .option("--network <network>", "Network (testnet or mainnet)", "testnet")
        .action((options) => {
            const db = getDatabase();
            const existing = getChannelAccounts(db, options.network)
                .find((a) => a.public_key === options.key);

            if (existing) {
                console.error(chalk.red(`Error: Key ${formatContractID(options.key)} is already registered.`));
                process.exit(1);
            }

            addChannel(db, options.key, options.network, options.label);
            console.log(
                chalk.green(`✔ Channel account registered successfully.`) +
                `\n  Key:     ${chalk.cyan(options.key)}` +
                (options.label ? `\n  Label:   ${options.label}` : "") +
                `\n  Network: ${options.network}`
            );
        });

    // ── channels list ───────────────────────────────────────────────────────
    channels
        .command("list")
        .description("List registered channel accounts")
        .option("--network <network>", "Network (testnet or mainnet)", "testnet")
        .action((options) => {
            const db = getDatabase();
            const accounts = getChannelAccounts(db, options.network);

            if (accounts.length === 0) {
                console.log(chalk.yellow(`No channel accounts registered for network: ${options.network}.`));
                return;
            }

            console.log();
            console.log(chalk.bold(`  Channel Accounts (${options.network})`));
            console.log();
            for (const account of accounts) {
                const fundedBadge = account.funded ? chalk.green(" [funded]") : chalk.dim(" [unfunded]");
                const label = account.label ? chalk.yellow(` ${account.label}`) : "";
                console.log(`  ${chalk.cyan(account.public_key)}${label}${fundedBadge}`);
            }
            console.log();
        });

    // ── channels fund ───────────────────────────────────────────────────────
    channels
        .command("fund")
        .description("Send XLM from master wallet to all registered channel accounts")
        .requiredOption("--master-key <secretKey>", "Master wallet secret key (source of funds)")
        .option("--amount <xlm>", "Amount of XLM to send to each channel account", "10")
        .option("--network <network>", "Network (testnet or mainnet)", "testnet")
        .option("-r, --rpc-url <url>", "Custom RPC endpoint URL")
        .action(async (options) => {
            const db = getDatabase();
            const accounts = getChannelAccounts(db, options.network);

            if (accounts.length === 0) {
                console.error(chalk.red(`No channel accounts registered for network: ${options.network}.`));
                console.error(chalk.dim("Run 'sorokeep channels add --key <key>' first."));
                process.exit(1);
            }

            console.log(`Funding ${accounts.length} channel account(s) with ${options.amount} XLM each...`);

            const result = await fundChannels(
                db,
                options.masterKey,
                options.amount,
                options.network,
                options.rpcUrl,
            );

            if (result.errors.length > 0) {
                for (const err of result.errors) {
                    console.error(chalk.red(`Error: ${err}`));
                }
            }

            if (result.funded > 0) {
                console.log(chalk.green(`✔ Funded ${result.funded} channel account(s) successfully.`));
                if (result.txHash) {
                    console.log(`  Tx hash: ${chalk.cyan(result.txHash)}`);
                }
            }
        });
}
