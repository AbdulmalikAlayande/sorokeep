import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, getResourceUsageHistory } from "../db/repositories.js";
import { formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "ResourcesCommand" });

function formatMetricValue(value: number): string {
    return value.toLocaleString();
}

function formatPercentage(value: number): string {
    return `${value.toFixed(1)}%`;
}

export function registerResourcesCommand(program: Command): void {
    program
        .command("resources <contractId>")
        .description("Show historical resource usage trends for a contract")
        .option("--period <days>", "Show usage for the last N days", "30")
        .option("--all", "Show all resource usage history")
        .action((contractId: string, options) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                }

                const days = options.all ? undefined : parseInt(options.period, 10);
                if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
                    console.error(chalk.red("--period must be a positive integer number of days"));
                    process.exit(1);
                }

                const history = getResourceUsageHistory(db, contractId, days);
                const displayName = contract.name ?? formatContractID(contractId);
                const periodLabel = days ? `last ${days} days` : "all time";

                console.log(`\n${chalk.bold("Resource Usage Trends")} — ${chalk.cyan(displayName)} (${periodLabel})`);
                console.log(`  Network: ${chalk.cyan(contract.network)}`);

                if (history.length === 0) {
                    console.log(chalk.dim("\n  No resource usage records found for this period."));
                    return;
                }

                const metrics = history.reduce((acc, record) => {
                    const bucket = acc[record.resourceType] ?? {
                        resourceType: record.resourceType,
                        count: 0,
                        totalUsage: 0,
                        minUsage: Number.POSITIVE_INFINITY,
                        maxUsage: Number.NEGATIVE_INFINITY,
                        totalPercent: 0,
                        minPercent: Number.POSITIVE_INFINITY,
                        maxPercent: Number.NEGATIVE_INFINITY,
                    };

                    bucket.count += 1;
                    bucket.totalUsage += record.usage;
                    bucket.minUsage = Math.min(bucket.minUsage, record.usage);
                    bucket.maxUsage = Math.max(bucket.maxUsage, record.usage);
                    bucket.totalPercent += record.usagePercent;
                    bucket.minPercent = Math.min(bucket.minPercent, record.usagePercent);
                    bucket.maxPercent = Math.max(bucket.maxPercent, record.usagePercent);

                    acc[record.resourceType] = bucket;
                    return acc;
                }, {} as Record<string, {
                    resourceType: "cpu" | "memory";
                    count: number;
                    totalUsage: number;
                    minUsage: number;
                    maxUsage: number;
                    totalPercent: number;
                    minPercent: number;
                    maxPercent: number;
                }>);

                console.log(`\n  ${chalk.bold("Summary")}`);
                console.log(`  Records: ${chalk.cyan(history.length.toString())}`);

                console.log(`\n  ${chalk.bold("Usage Metrics")}`);
                console.log(
                    `  ${chalk.bold("Resource".padEnd(8))}` +
                    ` ${chalk.bold("Count".padStart(6))}` +
                    ` ${chalk.bold("Avg Usage".padStart(14))}` +
                    ` ${chalk.bold("Min".padStart(14))}` +
                    ` ${chalk.bold("Max".padStart(14))}` +
                    ` ${chalk.bold("Avg %".padStart(8))}`
                );

                for (const resourceType of ["cpu", "memory"] as const) {
                    const bucket = metrics[resourceType];
                    if (!bucket) {
                        continue;
                    }

                    const resourceLabel = resourceType === "cpu" ? "CPU" : "Memory";
                    const avgUsage = bucket.totalUsage / bucket.count;
                    const avgPercent = bucket.totalPercent / bucket.count;

                    console.log(
                        `  ${resourceLabel.padEnd(8)}` +
                        ` ${bucket.count.toString().padStart(6)}` +
                        ` ${formatMetricValue(Math.round(avgUsage)).padStart(14)}` +
                        ` ${formatMetricValue(bucket.minUsage).padStart(14)}` +
                        ` ${formatMetricValue(bucket.maxUsage).padStart(14)}` +
                        ` ${formatPercentage(avgPercent).padStart(8)}`
                    );
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Resources command failed", { error: message });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });
}
