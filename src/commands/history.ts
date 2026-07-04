import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import {
    getContract,
    getStateChangeHistory,
} from "../db/repositories.js";
import { formatContractID } from "../utils/formatting.js";

export function registerHistoryCommand(program: Command): void {
    program
        .command("history <contract-id>")
        .description("Show state change history for a contract")
        .option("--limit <n>", "Max number of records to show", "20")
        .option("--entry <keyXdr>", "Filter by specific entry key XDR")
        .action((contractId: string, options: { limit: string; entry?: string }) => {
            const db = getDatabase();
            const limit = parseInt(options.limit, 10);

            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(
                    chalk.red(`Error: Contract ${formatContractID(contractId)} is not registered.`),
                );
                console.error(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                process.exit(1);
            }

            const history = getStateChangeHistory(db, contractId, {
                limit: limit > 0 ? limit : undefined,
                entryKeyXdr: options.entry,
            });

            const displayName = contract.name ?? formatContractID(contractId);

            if (history.length === 0) {
                console.log(
                    chalk.yellow(`No state change history found for contract ${displayName}.`),
                );
                return;
            }

            console.log(
                `\n${chalk.bold("State Change History")} — ${chalk.cyan(displayName)}\n`,
            );

            for (const record of history) {
                const typeIcon = diffTypeIcon(record.diffType);
                const label = record.entryLabel ?? record.entryType;
                const oldVal = record.oldValueXdr ?? "(none)";
                const newVal = record.newValueXdr ?? "(none)";

                console.log(
                    `  ${typeIcon} ${chalk.dim(record.createdAt)} | ` +
                    `${chalk.cyan(label)} | ` +
                    `${chalk.yellow(record.diffType)} | ` +
                    `ledger ${chalk.magenta(record.detectedAtLedger.toLocaleString())}`,
                );
                console.log(
                    `    ${chalk.dim("old:")} ${oldVal}`,
                );
                console.log(
                    `    ${chalk.dim("new:")} ${newVal}`,
                );
            }

            console.log();
        });
}

function diffTypeIcon(diffType: string): string {
    switch (diffType) {
        case "created":
            return chalk.green("+");
        case "updated":
            return chalk.yellow("~");
        case "deleted":
            return chalk.red("-");
        default:
            return chalk.dim("?");
    }
}
