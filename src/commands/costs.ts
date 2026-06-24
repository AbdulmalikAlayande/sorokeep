import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, getContractCostSummary, getExtensionHistory, getEntriesForContract } from "../db/repositories.js";
import { formatContractID, formatTimeToCloseLedger } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "CostsCommand" });

export function registerCostsCommand(program: Command): void {
    program
        .command("costs <contractId>")
        .description("Show rent costs and extension history for a contract")
        .option("--period <days>", "Show costs for the last N days", "30")
        .option("--all", "Show all extension history")
        .action(async (contractId: string, options) => {
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
                const history = getExtensionHistory(db, contractId, days);
                const summary = getContractCostSummary(db, contractId, days);

                const displayName = contract.name ?? formatContractID(contractId);
                const periodLabel = days ? `last ${days} days` : "all time";

                console.log(`\n${chalk.bold("Extension History")} — ${chalk.cyan(displayName)} (${periodLabel})`);
                console.log(`  Network: ${chalk.cyan(contract.network)}`);

                if (history.length === 0 && summary.total_extensions === 0) {
                    console.log(chalk.dim("\n  No extensions recorded for this period."));
                    return;
                }

                const totalCostXlm = summary.total_cost_xlm;
                const byType = summary.byType;

                // Summary
                console.log(`\n  ${chalk.bold("Summary")}`);
                console.log(`  Total extensions: ${chalk.cyan(summary.total_extensions.toString())}`);
                console.log(`  Total cost:       ${chalk.cyan(totalCostXlm.toFixed(7))} XLM`);

                // Breakdown by entry type
                console.log(`\n  ${chalk.bold("By Entry Type")}`);
                for (const [type, data] of Object.entries(byType)) {
                    console.log(`    ${type}: ${data.count} extensions (${data.cost_xlm.toFixed(7)} XLM)`);
                }

                // Cost projection
                if (days && summary.total_extensions > 0) {
                    const projectedCost = (totalCostXlm / (days)) * 30;
                    console.log(`\n  ${chalk.bold("Projection")}`);
                    console.log(`  Estimated 30-day cost: ~${chalk.cyan(projectedCost.toFixed(7))} XLM`);
                }

                // Recent history
                console.log(`\n  ${chalk.bold("Recent Extensions")}`);
                const recent = options.all ? history : history.slice(0, 10);
                for (const record of recent) {
                    const entry = entryMap.get(record.contract_entry_id);
                    const label = entry?.label ?? entry?.entry_type ?? "unknown";
                    const cost = record.cost_xlm !== null ? `${record.cost_xlm.toFixed(7)} XLM` : "N/A";
                    const oldTTL = formatTimeToCloseLedger(record.old_ttl_ledgers);
                    const newTTL = formatTimeToCloseLedger(record.new_ttl_ledgers);

                    console.log(`    ${chalk.dim(record.executed_at)} ${label}: ${oldTTL} → ${newTTL} (${cost})`);
                    console.log(`      ${chalk.dim(`tx: ${record.tx_hash.slice(0, 16)}...`)}`);
                }

                if (!options.all && history.length > 10) {
                    console.log(chalk.dim(`\n    ... and ${history.length - 10} more. Use --all to see everything.`));
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Costs command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
