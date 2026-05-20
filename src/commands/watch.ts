import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database";
import { getLogger } from "../logging";
import {classifyTTL, formatContractID, formatTimeToCloseLedger, statusIndicator} from "../utils/formatting";
import {watchContract} from "../core/watch";

const logger = getLogger().child({ component: 'WatchCommand' });

export const registerWatchCommand = (program: Command): void => {
    program.command("watch <contract-id>")
        .description("Register and start watching a contract")
        .option("-n, --name <name>", "A human-readable name for the contract")
        .option("--network <network>", "The stellar network to use (testnet, mainnet)", "testnet")
        .option("-r, --rpc-url <url>", "Custom RPC URL")
        .option("--storage-keys <keys>", "Comma-separated base64 XDR storage keys to watch")
        .action(async (contractId, options) => {
            const displayId = formatContractID(contractId);
            const spinner = ora(`Registering contract ${formatContractID(contractId)} and discovering entries...`).start();
            try {
                const db = getDatabase();
                const watchResult = await watchContract(db, {contractId, network: options.network, name: options.name, rpcUrl: options.rpcUrl, storageKeys: options.storageKeys});
                if (!watchResult.success) {
                    spinner.fail(chalk.red(watchResult.error))
                    process.exit(1);
                }
                spinner.succeed(chalk.green(`Contract ${options.name || displayId} registered successfully.`));
                const entryCount = 1 + (watchResult.wasm ? 1 : 0) + (options.storageKeys ? options.storageKeys.split(",").length : 0);
                logger.info(`Entries indexed: ${entryCount}`);

                // Contract Summary/Details
                logger.info(`Contract: ${options.name ?? displayId} (${displayId})`);
                logger.info(`Network: ${options.network}`);

                // Contract Instance TimeToLive
                const instanceTTLStatus = classifyTTL(watchResult.instance.remainingTTL);
                logger.info(`Contract Instance TTL: ${instanceTTLStatus.toLocaleString()} 
                    ledgers (${formatTimeToCloseLedger(watchResult.instance.remainingTTL)}) 
                    ${statusIndicator(instanceTTLStatus)}
                `)

                // WASM TimeToLive
                if(watchResult.wasm) {
                    const wasmTTLStatus = classifyTTL(watchResult.wasm.remainingTTL);
                    logger.info(`WASM Code TTL: ${wasmTTLStatus.toLocaleString()} 
                        ledgers (${formatTimeToCloseLedger(watchResult.wasm.remainingTTL)}) 
                        ${statusIndicator(wasmTTLStatus)}
                    `);
                }

                // Warnings
                if (watchResult.wasmWarning) {
                    logger.warn(`\n  ⚠ ${watchResult.wasmWarning}`)
                }


                logger.info(chalk.dim("\n  Run 'sentinel status " + formatContractID(contractId) + "' to check TTLs anytime."));
                logger.info(chalk.dim("  Run 'sentinel guard " + formatContractID(contractId) + "' to enable auto-extension."));
            }
            catch(error: any){
                const errorMessage = error instanceof Error ? error.message : String(error);
                spinner.fail(chalk.red(`Failed to watch contract: ${errorMessage}`));
                logger.error("Watch command failed",  { error: errorMessage });
                process.exit(1);
            }

        })

}