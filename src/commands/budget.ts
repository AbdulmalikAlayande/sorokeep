import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { setContractBudget, getMonthlySpendProgress } from "../core/budget.js";
import { formatContractID } from "../utils/formatting.js";

export function registerBudgetCommand(program: Command): void {
    const budgetCmd = program
        .command("budget")
        .description("Manage monthly spending bounds for contracts");

    budgetCmd
        .command("set")
        .description("Set a monthly budget limit for a contract")
        .requiredOption("--contract <contractId>", "Contract ID to set budget for")
        .requiredOption("--limit <limit>", "Monthly limit in XLM", parseFloat)
        .action((options: { contract: string; limit: number }) => {
            const db = getDatabase();
            if (isNaN(options.limit) || options.limit < 0) {
                console.log(chalk.red("Invalid limit. Must be a positive number."));
                process.exit(1);
            }

            setContractBudget(db, options.contract, options.limit);
            console.log(chalk.green(`Budget set to ${options.limit} XLM for ${formatContractID(options.contract)}.`));
        });

    budgetCmd
        .command("status <contractId>")
        .description("View current budget status and spend progress")
        .action((contractId: string) => {
            const db = getDatabase();
            const progress = getMonthlySpendProgress(db, contractId);

            if (!progress) {
                console.log(chalk.yellow(`No budget configured for ${formatContractID(contractId)}.`));
                process.exit(0);
                return;
            }

            const { limit, spend, percentage } = progress;

            console.log();
            console.log(chalk.bold(`  Budget Status`) + chalk.dim(` (${formatContractID(contractId)})`));
            
            // Draw progress bar
            const barWidth = 40;
            const filledWidth = Math.min(barWidth, Math.floor((percentage / 100) * barWidth));
            const emptyWidth = barWidth - filledWidth;
            
            const bar = chalk.green("█".repeat(filledWidth)) + chalk.dim("░".repeat(emptyWidth));
            
            console.log(`  ${bar} ${percentage.toFixed(1)}%`);
            console.log(`  ${spend.toFixed(2)} / ${limit.toFixed(2)} XLM spent this month`);
            console.log();
        });
}
