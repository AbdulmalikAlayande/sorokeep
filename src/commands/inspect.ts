import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { inspectContract } from "../core/inspect.js";
import { statusIndicator, formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "InspectCommand" });

export function registerInspectCommand(program: Command): void {
    program
        .command("inspect <contractId>")
        .description("Inspect contract storage and token balances")
        .option("--entry <keyOrShortcut>", "Specific entry key XDR or shortcut (e.g. balance:<address>)", collect, [])
        .option("--network <network>", "The stellar network to use (testnet, mainnet)")
        .option("-r, --rpc-url <url>", "Custom RPC URL")
        .action(async (contractId: string, options: { entry: string[]; network?: string; rpcUrl?: string }) => {
            const spinner = ora(`Inspecting contract ${formatContractID(contractId)}...`).start();
            try {
                const db = getDatabase();
                const result = await inspectContract(db, contractId, {
                    entries: options.entry,
                    network: options.network,
                    rpcUrl: options.rpcUrl,
                });

                if (!result.success) {
                    spinner.fail(chalk.red("Inspection failed"));
                    console.error(chalk.red(result.error));
                    process.exit(1);
                    return;
                }

                const displayName = result.contractName ?? formatContractID(contractId);
                spinner.succeed(chalk.green(`Inspected ${displayName}`));

                console.log();
                console.log(`  Contract: ${chalk.bold.cyan(displayName)} (${chalk.dim(formatContractID(contractId))})`);
                console.log(`  Network:  ${chalk.cyan(result.network)}`);
                if (result.isSac) {
                    console.log(`  Type:     ${chalk.cyan("Stellar Asset Contract (SAC)")}`);
                    console.log(`  Decimals: ${chalk.cyan(result.decimals)}`);
                }
                console.log();

                if (!result.results || result.results.length === 0) {
                    console.log(chalk.yellow("  No entries specified to inspect. Use --entry <keyXdr> or --entry balance:<address>"));
                    console.log();
                    return;
                }

                for (const item of result.results) {
                    console.log(chalk.bold(`  Entry: ${item.inputEntry}`));
                    if (item.type === "balance" && item.balance) {
                        console.log(`    Balance:    ${chalk.bold.green(item.formattedBalance)}`);
                        console.log(`    Raw Amount: ${item.balance.amount.toString()}`);
                        console.log(`    Authorized: ${item.balance.authorized}`);
                        console.log(`    Clawback:   ${item.balance.clawback}`);
                    }

                    if (!item.found || item.status === "unknown" || item.remainingTTL == null) {
                        console.log(chalk.red(`    Error: Target key is not active on-chain`));
                    } else {
                        if (item.type === "raw" && item.decodedValue) {
                            console.log(chalk.cyan(`    Decoded Value:`));
                            const formattedJson = JSON.stringify(item.decodedValue, null, 2)
                                .split('\n')
                                .map(line => `      ${line}`)
                                .join('\n');
                            console.log(formattedJson);
                        }
                        console.log(
                            `    TTL:        ${item.remainingTTL.toLocaleString()} ledgers (${item.approximateTimeRemaining})  ${statusIndicator(item.status as any)}`,
                        );
                    }
                    console.log();
                }
            } catch (error: any) {
                const msg = error instanceof Error ? error.message : String(error);
                spinner.fail(chalk.red("Error"));
                console.error(chalk.red(`Error: ${msg}`));
                logger.error("Inspect command failed", { error: msg });
                process.exit(1);
            }
        });
}

function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}
