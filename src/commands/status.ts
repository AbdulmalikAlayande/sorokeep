import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getAllContracts } from "../db/repositories.js";
import { getContractStatus, ContractNotFoundError } from "../core/status.js";
import {
    statusIndicator,
    formatContractID,
    validateContractId,
    paginateList,
    formatPaginationFooter,
} from "../utils/formatting.js";

export function registerStatusCommand(program: Command): void {
    const status = program
        .command("status")
        .description("Show TTL and storage health for watched contracts");

    status
        .command("list")
        .description("List all watched contracts")
        .option("--page <n>", "Page number", "1")
        .option("--page-size <n>", "Items per page", "25")
        .action((options: { page?: string; pageSize?: string } = {}) => {
            const db = getDatabase();
            const contracts = getAllContracts(db);

            if (contracts.length === 0) {
                console.log();
                console.log(chalk.yellow("  No contracts watched yet."));
                console.log(chalk.dim("  Run 'sorokeep watch <contractId>' first."));
                console.log();
                return;
            }

            const page = parseInt(options.page ?? "1", 10);
            const pageSize = parseInt(options.pageSize ?? "25", 10);
            const result = paginateList(contracts, page, pageSize);

            console.log();
            console.log(chalk.bold("  Watched Contracts"));
            console.log();

            for (const contract of result.items) {
                const displayName = contract.name ?? formatContractID(contract.id);
                const ledgerStr = contract.last_checked_ledger != null
                    ? `ledger ${contract.last_checked_ledger.toLocaleString()}`
                    : chalk.dim("never checked");
                console.log(
                    `  ${chalk.cyan(formatContractID(contract.id))}  ${displayName}  ${contract.network}  ${ledgerStr}`,
                );
            }

            console.log();
            console.log(chalk.dim(`  ${formatPaginationFooter(result.meta)}`));
            console.log();
        });

    status
        .argument("<contractId>", "Contract ID to inspect")
        .option("--json", "Output machine-readable JSON")
        .action((contractId: string, options: { json?: boolean } = {}) => {
            const contractIdValidation = validateContractId(contractId);
            if (!contractIdValidation.valid) {
                if (options.json) {
                    console.log(JSON.stringify({ success: false, error: "invalid_contract_id", contractId, message: contractIdValidation.reason }));
                } else {
                    console.error(chalk.red(`Invalid contract ID: ${contractIdValidation.reason}`));
                }
                process.exit(1);
                return;
            }

            const db = getDatabase();

            try {
                const status = getContractStatus(db, contractId);

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

                    if (entry.projectedCrossingLedger != null) {
                        const projTime = entry.projectedCrossingAt
                            ? ` (~${new Date(entry.projectedCrossingAt).toUTCString()})`
                            : "";
                        console.log(
                            chalk.dim(`  ${"".padEnd(maxLabelLen)}  Predicted threshold crossing: ledger ${entry.projectedCrossingLedger.toLocaleString()}${projTime}`),
                        );
                    }
                }

                console.log();
            } catch (error: unknown) {
                if (error instanceof ContractNotFoundError || (error instanceof Error && error.name === "ContractNotFoundError")) {
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
        });
}
