import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getLogger } from "../logging/index.js";
import {classifyTTL, formatContractID, formatTimeToCloseLedger, statusIndicator} from "../utils/formatting.js";
import {watchContract} from "../core/watch.js";

const logger = getLogger().child({ component: 'WatchCommand' });

export const registerWatchCommand = (program: Command): void => {
    program.command("watch <contract-id>")
        .description("Register and start watching a contract")
        .option("-n, --name <name>", "A human-readable name for the contract")
        .option("--network <network>", "The stellar network to use (testnet, mainnet)", "testnet")
        .option("-r, --rpc-url <url>", "Custom RPC URL")
        .option("--storage-keys <keys>", "Comma-separated base64 XDR storage keys to watch")
        .option("--no-introspection", "Skip automatic contract introspection (WASM code fetching)")
        .action(async (contractId, options) => {
            const displayId = formatContractID(contractId);
            const spinner = ora(`Registering contract ${formatContractID(contractId)} and discovering entries...`).start();
            try {
                const db = getDatabase();
                const watchResult = await watchContract(db, {
                    contractId,
                    network: options.network,
                    name: options.name,
                    rpcUrl: options.rpcUrl,
                    storageKeys: options.storageKeys,
                    noIntrospection: options.noIntrospection,
                });
                if (!watchResult.success) {
                    spinner.fail(chalk.red(watchResult.error))
                    process.exit(1);
                }
                spinner.succeed(chalk.green(`Contract ${options.name || displayId} registered successfully.`));
                const entryCount = 1 + (watchResult.wasm ? 1 : 0) + (options.storageKeys ? options.storageKeys.split(",").length : 0);

                // Contract Summary/Details
                console.log(`\n  Contract: ${chalk.cyan(options.name ?? displayId)} (${chalk.dim(displayId)})`);
                console.log(`  Network:  ${chalk.cyan(options.network)}`);
                console.log(`  Entries:  ${chalk.cyan(entryCount)} discovered`);

                // Contract Instance TimeToLive
                const instanceTTL = watchResult.instance.remainingTTL;
                const instanceStatus = classifyTTL(instanceTTL);
                console.log(`  Instance TTL: ${instanceTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(instanceTTL)})  ${statusIndicator(instanceStatus)}`);

                // WASM TimeToLive
                if (watchResult.wasm) {
                    const wasmTTL = watchResult.wasm.remainingTTL;
                    const wasmStatus = classifyTTL(wasmTTL);
                    console.log(`  WASM Code TTL: ${wasmTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(wasmTTL)})  ${statusIndicator(wasmStatus)}`);
                }

                // Warnings
                if (watchResult.wasmWarning) {
                    console.warn(chalk.yellow(`\n  ⚠ ${watchResult.wasmWarning}`))
                }


                console.log(chalk.dim("\n  Run 'sorokeep status " + formatContractID(contractId) + "' to check TTLs anytime."));
                console.log(chalk.dim("  Run 'sorokeep guard " + formatContractID(contractId) + "' to enable auto-extension."));
            }
            catch(error: any){
                const errorMessage = error instanceof Error ? error.message : String(error);
                spinner.fail(chalk.red(`Failed to watch contract: ${errorMessage}`));
                logger.error("Watch command failed",  { error: errorMessage });
                process.exit(1);
            }

        })

}