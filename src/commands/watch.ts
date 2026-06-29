import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getLogger } from "../logging/index.js";
import {
  classifyTTL,
  formatContractID,
  formatTimeToCloseLedger,
  statusIndicator,
} from "../utils/formatting.js";
import { watchContract } from "../core/watch.js";
import { loadWatchContractsFile } from "../utils/watch-config.js";

const logger = getLogger().child({ component: "WatchCommand" });

export const registerWatchCommand = (program: Command): void => {
  program
    .command("watch [contract-id]")
    .description("Register and start watching a contract")
    .option("-n, --name <name>", "A human-readable name for the contract")
    .option(
      "--network <network>",
      "The stellar network to use (testnet, mainnet)",
      "testnet",
    )
    .option("-r, --rpc-url <url>", "Custom RPC URL")
    .option(
      "--storage-keys <keys>",
      "Comma-separated base64 XDR storage keys to watch",
    )
    .option(
      "--no-introspection",
      "Skip automatic contract introspection (WASM code fetching)",
    )
    .option(
      "--from-file <path>",
      "Load multiple contract registrations from a YAML or JSON file",
    )
    .action(async (contractId, options) => {
      try {
        const db = getDatabase();

        if (options.fromFile) {
          const configs = loadWatchContractsFile(options.fromFile);
          const results = [] as Array<{
            contractId: string;
            name?: string;
            network: string;
            status: "SUCCESS" | "FAILED";
            message: string;
          }>;

          for (const config of configs) {
            const watchResult = await watchContract(db, {
              contractId: config.contractId,
              network: config.network,
              name: config.name,
              rpcUrl: config.rpcUrl,
              storageKeys: config.storageKeys,
              noIntrospection: config.noIntrospection,
            });

            results.push({
              contractId: config.contractId,
              name: config.name,
              network: config.network,
              status: watchResult.success ? "SUCCESS" : "FAILED",
              message: watchResult.success
                ? `Registered ${config.name ?? formatContractID(config.contractId)}`
                : watchResult.error,
            });
          }

          printBatchSummary(results);

          if (results.some((result) => result.status === "FAILED")) {
            process.exit(1);
          }
          return;
        }

        if (!contractId) {
          console.log(
            chalk.red(
              "A contract ID is required unless --from-file is provided.",
            ),
          );
          process.exit(1);
          return;
        }

        const displayId = formatContractID(contractId);
        const spinner = ora(
          `Registering contract ${formatContractID(contractId)} and discovering entries...`,
        ).start();
        const watchResult = await watchContract(db, {
          contractId,
          network: options.network,
          name: options.name,
          rpcUrl: options.rpcUrl,
          storageKeys: options.storageKeys,
          noIntrospection: options.noIntrospection,
        });
        if (!watchResult.success) {
          spinner.fail(chalk.red(watchResult.error));
          process.exit(1);
          return;
        }
        spinner.succeed(
          chalk.green(
            `Contract ${options.name || displayId} registered successfully.`,
          ),
        );
        const entryCount =
          1 +
          (watchResult.wasm ? 1 : 0) +
          (options.storageKeys ? options.storageKeys.split(",").length : 0);

        console.log(
          `\n  Contract: ${chalk.cyan(options.name ?? displayId)} (${chalk.dim(displayId)})`,
        );
        console.log(`  Network:  ${chalk.cyan(options.network)}`);
        console.log(`  Entries:  ${chalk.cyan(entryCount)} discovered`);

        const instanceTTL = watchResult.instance.remainingTTL;
        const instanceStatus = classifyTTL(instanceTTL);
        console.log(
          `  Instance TTL: ${instanceTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(instanceTTL)})  ${statusIndicator(instanceStatus)}`,
        );

        if (watchResult.wasm) {
          const wasmTTL = watchResult.wasm.remainingTTL;
          const wasmStatus = classifyTTL(wasmTTL);
          console.log(
            `  WASM Code TTL: ${wasmTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(wasmTTL)})  ${statusIndicator(wasmStatus)}`,
          );
        }

        if (watchResult.wasmWarning) {
          console.warn(chalk.yellow(`\n  ⚠ ${watchResult.wasmWarning}`));
        }

        console.log(
          chalk.dim(
            "\n  Run 'sorokeep status " +
              formatContractID(contractId) +
              "' to check TTLs anytime.",
          ),
        );
        console.log(
          chalk.dim(
            "  Run 'sorokeep guard " +
              formatContractID(contractId) +
              "' to enable auto-extension.",
          ),
        );
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error("Watch command failed", { error: errorMessage });
        console.log(chalk.red(`Failed to watch contract: ${errorMessage}`));
        process.exit(1);
      }
    });
};

function printBatchSummary(
  results: Array<{
    contractId: string;
    name?: string;
    network: string;
    status: "SUCCESS" | "FAILED";
    message: string;
  }>,
): void {
  const rows = results.map((result) => {
    const label = result.name ?? formatContractID(result.contractId);
    return `${result.status.padEnd(7)} | ${label.padEnd(18)} | ${result.network.padEnd(8)} | ${result.message}`;
  });

  const successCount = results.filter(
    (result) => result.status === "SUCCESS",
  ).length;
  const failureCount = results.length - successCount;

  console.log("\nBatch registration summary");
  console.log("STATUS  | CONTRACT           | NETWORK  | MESSAGE");
  console.log("--------|--------------------|----------|--------");
  for (const row of rows) {
    console.log(row);
  }
  console.log(`\n${successCount} succeeded, ${failureCount} failed`);
}
