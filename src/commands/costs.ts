import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getExtensionCosts, calculateFeeAdjustedProjection, getMultiPeriodCosts, type MultiPeriodCostsData } from "../core/costs.js";
import { StellarRpcClient } from "../rpc/client.js";
import { formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";
import type { FeeStatsResult } from "../rpc/client.js";

const logger = getLogger().child({ component: "CostsCommand" });

function padRight(str: string, len: number): string {
    return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
    return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

function printMultiPeriodTable(
    data: MultiPeriodCostsData,
    feeStats?: Pick<FeeStatsResult, "baseFeeStroops" | "surgePricingMultiplier">,
): void {
    const displayName = data.contract.name ?? formatContractID(data.contract.id);

    console.log(`\n${chalk.bold("Extension Costs")} — ${chalk.cyan(displayName)}`);
    console.log(`  Network: ${chalk.cyan(data.contract.network)}`);

    const header = `  ${padRight("Period", 12)} ${padLeft("Extensions", 12)} ${padLeft("Total XLM", 16)}`;
    console.log(`\n${chalk.bold(header)}`);
    console.log(`  ${"─".repeat(40)}`);

    for (const p of data.periods) {
        const period = padRight(`${p.days} days`, 12);
        const extensions = padLeft(p.totalExtensions.toString(), 12);
        const cost = padLeft(p.totalCostXlm.toFixed(7), 16);
        console.log(`  ${period} ${chalk.cyan(extensions)} ${chalk.cyan(cost)}`);
    }

    console.log(`\n  ${chalk.bold("Projection")}`);
    console.log(`  Estimated 30-day cost: ~${chalk.cyan(data.projection.adjustedProjectedCostXlm.toFixed(7))} XLM`);
    if (feeStats) {
        console.log(`  Live base fee:        ${chalk.cyan(feeStats.baseFeeStroops.toString())} stroops`);
        console.log(`  Surge multiplier:     ${chalk.cyan(`${data.projection.surgePricingMultiplier.toFixed(2)}x`)}`);
    }
}

export function registerCostsCommand(program: Command): void {
    program
        .command("costs <contractId>")
        .description("Show rent costs and extension history for a contract")
        .option("--period <days>", "Show costs for the last N days", "30")
        .option("--all", "Show all extension history")
        .action(async (contractId: string, options) => {
            try {
                const db = getDatabase();
                const days = options.all ? undefined : parseInt(options.period, 10);

                if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
                    console.error(chalk.red("--period must be a positive integer number of days"));
                    process.exit(1);
                }

                const result = getExtensionCosts(
                    db,
                    contractId,
                    options.all ? { all: true } : { period: days },
                );

                if (!result.success) {
                    if (result.error === "contract_not_found") {
                        console.error(
                            chalk.red(
                                `Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`,
                            ),
                        );
                    } else {
                        console.error(chalk.red("--period must be a positive integer number of days"));
                    }
                    process.exit(1);
                }

                const { data } = result;
                const displayName = data.contract.name ?? formatContractID(contractId);

                let feeStats: Pick<FeeStatsResult, "baseFeeStroops" | "surgePricingMultiplier"> | undefined;
                try {
                    feeStats = await new StellarRpcClient(data.contract.network).getFeeStats();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn("Unable to fetch live fee stats; using historical projection", { error: message });
                }

                const multiResult = getMultiPeriodCosts(db, contractId, feeStats);
                if (multiResult.success) {
                    printMultiPeriodTable(multiResult.data, feeStats);
                }

                console.log(
                    `\n${chalk.bold("Extension History")} — ${chalk.cyan(displayName)} (${data.period.label})`,
                );
                console.log(`  Network: ${chalk.cyan(data.contract.network)}`);

                if (data.message) {
                    console.log(chalk.dim(`\n  ${data.message}`));
                    return;
                }

                console.log(`\n  ${chalk.bold("Summary")}`);
                console.log(`  Total extensions: ${chalk.cyan(data.summary.totalExtensions.toString())}`);
                console.log(`  Total cost:       ${chalk.cyan(data.summary.totalCostXlm.toFixed(7))} XLM`);

                console.log(`\n  ${chalk.bold("By Entry Type")}`);
                for (const [type, entryData] of Object.entries(data.byEntryType)) {
                    console.log(
                        `    ${type}: ${entryData.count} extensions (${entryData.costXlm.toFixed(7)} XLM)`,
                    );
                }

                if (days && data.summary.totalExtensions > 0) {
                    const projection = calculateFeeAdjustedProjection(data.summary.totalCostXlm, days, feeStats);
                    console.log(`\n  ${chalk.bold("Projection")}`);
                    console.log(`  Estimated 30-day cost: ~${chalk.cyan(projection.adjustedProjectedCostXlm.toFixed(7))} XLM`);
                    if (feeStats) {
                        console.log(`  Live base fee:     ${chalk.cyan(feeStats.baseFeeStroops.toString())} stroops`);
                        console.log(`  Surge multiplier:  ${chalk.cyan(`${projection.surgePricingMultiplier.toFixed(2)}x`)}`);
                    }
                }

                console.log(`\n  ${chalk.bold("Recent Extensions")}`);
                const recent = options.all ? data.recentExtensions : data.recentExtensions.slice(0, 10);
                for (const record of recent) {
                    const cost =
                        record.costXlm !== null ? `${record.costXlm.toFixed(7)} XLM` : "N/A";

                    console.log(
                        `    ${chalk.dim(record.executedAt)} ${record.entryLabel}: ${record.oldTtlFormatted} → ${record.newTtlFormatted} (${cost})`,
                    );
                    console.log(`      ${chalk.dim(`tx: ${record.txHash.slice(0, 16)}...`)}`);
                }

                if (!options.all && data.recentExtensions.length > 10) {
                    console.log(
                        chalk.dim(
                            `\n    ... and ${data.recentExtensions.length - 10} more. Use --all to see everything.`,
                        ),
                    );
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Costs command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
