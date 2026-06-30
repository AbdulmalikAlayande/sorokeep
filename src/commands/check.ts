import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { checkContractTTL } from "../core/check.js";
import { classifyTTL, formatContractID, formatTimeToCloseLedger, statusIndicator } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "CheckCommand" });

export const registerCheckCommand = (program: Command): void => {
    program.command("check <contract-id>")
        .description("One-shot TTL check: fails with exit code 1 if TTL is below threshold")
        .option("--network <network>", "Stellar network to use (testnet, mainnet)", "testnet")
        .option("--threshold <ledgers>", "Minimum required TTL in ledgers", "500")
        .option("-r, --rpc-url <url>", "Custom RPC endpoint URL")
        .option("--json", "Output result as JSON (useful for CI integrations)")
        .action(async (contractId: string, options) => {
            const threshold = Number(options.threshold);

            if (!Number.isInteger(threshold) || threshold < 0) {
                console.error(chalk.red(`Invalid threshold: "${options.threshold}". Must be a non-negative integer.`));
                process.exitCode = 1;
                    return;
            }

            const spinner = options.json
                ? null
                : ora(`Checking TTL for ${formatContractID(contractId)} on ${options.network}...`).start();

            try {
                const result = await checkContractTTL(
                    contractId,
                    options.network,
                    threshold,
                    options.rpcUrl,
                );

                if (options.json) {
                    console.log(JSON.stringify({
                        contractId: result.contractId,
                        network: result.network,
                        threshold: result.threshold,
                        minimumTTL: result.minimumTTL,
                        latestLedger: result.latestLedger,
                        passed: result.passed,
                        entries: result.entries,
                        error: result.error,
                    }));
                    process.exitCode = result.passed ? 0 : 1;
                    return;
                }

                if (result.error) {
                    spinner!.fail(chalk.red(`TTL check error: ${result.error}`));
                    logger.error("TTL check error", { error: result.error });
                    process.exitCode = 1;
                    return;
                }

                const displayId = formatContractID(contractId);

                if (result.passed) {
                    spinner!.succeed(chalk.green(`TTL check passed for ${displayId}`));
                } else {
                    spinner!.fail(chalk.red(`TTL check FAILED for ${displayId} — TTL is below threshold`));
                }

                console.log(`\n  Contract: ${chalk.cyan(displayId)}`);
                console.log(`  Network:  ${chalk.cyan(result.network)}`);
                console.log(`  Threshold: ${chalk.cyan(result.threshold.toLocaleString())} ledgers`);
                console.log(`  Latest ledger: ${chalk.dim(result.latestLedger.toLocaleString())}`);

                for (const entry of result.entries) {
                    const status = classifyTTL(entry.remainingTTL);
                    const label = entry.entryType === "instance" ? "Instance TTL" : "WASM Code TTL";
                    console.log(
                        `  ${label}: ${chalk.cyan(entry.remainingTTL.toLocaleString())} ledgers` +
                        ` (${formatTimeToCloseLedger(entry.remainingTTL)})  ${statusIndicator(status)}`,
                    );
                }

                if (!result.passed) {
                    console.log(chalk.red(`\n  Minimum TTL (${result.minimumTTL.toLocaleString()}) is below threshold (${threshold.toLocaleString()}).`));
                    console.log(chalk.dim("  Run 'sorokeep guard <contract-id>' to extend the TTL."));
                } else {
                    console.log(chalk.green(`\n  Minimum TTL (${result.minimumTTL.toLocaleString()}) meets threshold (${threshold.toLocaleString()}).`));
                }

                process.exitCode = result.passed ? 0 : 1;
                    return;
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (spinner) {
                    spinner.fail(chalk.red(`Failed to check TTL: ${message}`));
                } else {
                    console.error(chalk.red(`Failed to check TTL: ${message}`));
                }
                logger.error("Check command failed", { error: message });
                process.exitCode = 1;
                    return;
            }
        });
};
