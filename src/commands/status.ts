import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContractStatus, ContractNotFoundError } from "../core/status.js";
import {
    statusIndicator,
    formatContractID,
} from "../utils/formatting.js";

export function registerStatusCommand(program: Command): void {
    program
        .command("status <contractId>")
        .description("Show TTL and storage health for a watched contract")
        .option("--json", "Output machine-readable JSON")
        .action((contractId: string, options: { json?: boolean } = {}) => {
            options = options || {};
            const db = getDatabase();

            let status;
            try {
                status = getContractStatus(db, contractId);
            } catch (error: any) {
                if (error instanceof ContractNotFoundError || error?.name === "ContractNotFoundError") {
                    if (options.json) {
                        console.log(JSON.stringify({
                            success: false,
                            error: "contract_not_found",
                            contractId,
                            message: `Contract ${formatContractID(contractId)} is not registered.`,
                        }));
                    } else {
                        console.log(chalk.red(`Contract ${formatContractID(contractId)} is not registered.`));
                        console.log(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                    }
                    process.exit(1);
                    return;
                }
                throw error;
            }

            if (options.json) {
                console.log(JSON.stringify(status, null, 2));
                return;
            }

            const displayName = status.name ?? formatContractID(contractId);

            console.log();
            console.log(chalk.bold(`  ${displayName}`) + chalk.dim(` (${formatContractID(contractId)})`));
            console.log(`  Network: ${chalk.cyan(status.network)}`);
            if (status.lastCheckedLedger != null) {
                console.log(chalk.dim(`  Last checked: ledger ${status.lastCheckedLedger.toLocaleString()}`));
            }
            console.log();

            if (status.entries.length === 0) {
                console.log(chalk.yellow("  No entries tracked for this contract."));
                console.log();
                return;
            }

            const maxLabelLen = Math.max(...status.entries.map((entry) => entry.label.length));

            for (const entry of status.entries) {
                const paddedLabel = entry.label.padEnd(maxLabelLen);

                if (entry.status === "unknown") {
                    console.log(`  ${paddedLabel}  TTL: ${chalk.dim("unknown")}`);
                    continue;
                }

                console.log(
                    `  ${paddedLabel}  TTL: ${entry.remainingTTL!.toLocaleString().padStart(9)} ledgers (${entry.approximateTimeRemaining})  ${statusIndicator(entry.status)}`,
                );
            }

            console.log();
        });
}
