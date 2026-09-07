import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import {
    classifyTTL,
    statusIndicator,
    formatTimeToCloseLedger,
    formatContractID,
    validateContractId,
} from "../utils/formatting.js";

export function registerCheckCommand(program: Command): void {
    program
        .command("check <contractId>")
        .description("Check TTL health for a watched contract (CI-friendly, can be forced)")
        .option("--force", "Bypass CI TTL failures and exit 0")
        .requiredOption(
            "--fail-under <ledgers>",
            "Exit with code 1 if any entry TTL is below this many ledgers",
            parseInt,
        )
        .action((contractId: string, options: { failUnder: number; force?: boolean }) => {
            const validation = validateContractId(contractId);
            if (!validation.valid) {
                console.error(chalk.red(`Invalid contract ID: ${validation.reason}`));
                process.exit(1);
                return;
            }

            let spinner: ReturnType<typeof ora> | undefined;

            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.log(chalk.red(`Contract ${formatContractID(contractId)} is not registered.`));
                    console.log(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                    process.exit(1);
                    return;
                }

                const displayName = contract.name ?? formatContractID(contractId);
                spinner = ora(`Checking TTL health for ${displayName}...`).start();

                const entries = getEntriesForContract(db, contractId);
                const lastChecked = contract.last_checked_ledger;

                if (entries.length === 0 || lastChecked == null) {
                    spinner.succeed(chalk.green("All TTLs are safe."));
                    process.exit(0);
                    return;
                }

                let hasFailure = false;
                const outputLines: string[] = [];

                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    if (!entry) continue;
                    spinner.text = `Checking entry ${i + 1} of ${entries.length} for ${displayName}...`;
                    if (entry.live_until_ledger == null) continue;

                    const remainingTTL = entry.live_until_ledger - lastChecked;
                    const label =
                        entry.entry_type === "instance"
                            ? "Instance"
                            : entry.entry_type === "wasm"
                              ? "WASM Code"
                              : entry.label ?? entry.entry_type;
                    const timeStr = formatTimeToCloseLedger(remainingTTL);
                    const status = classifyTTL(remainingTTL);

                    if (remainingTTL < options.failUnder) {
                        hasFailure = true;
                        outputLines.push(
                            `${chalk.bold(label)}  TTL: ${remainingTTL.toLocaleString().padStart(9)} ledgers (${timeStr})  ${statusIndicator(status)}  ${chalk.red("FAIL")}`,
                        );
                    } else {
                        outputLines.push(
                            `${chalk.bold(label)}  TTL: ${remainingTTL.toLocaleString().padStart(9)} ledgers (${timeStr})  ${statusIndicator(status)}  ${chalk.green("PASS")}`,
                        );
                    }
                }

                if (hasFailure) {
                    spinner.fail(chalk.red("TTL health check failed"));
                    for (const line of outputLines) {
                        console.log(line);
                    }
                    if (options.force) {
                        console.log("WARNING: CI checks bypassed with --force");
                        process.exit(0);
                    } else {
                        process.exit(1);
                    }
                } else {
                    spinner.succeed(chalk.green("All TTLs are safe."));
                    for (const line of outputLines) {
                        console.log(line);
                    }
                    process.exit(0);
                }
            } catch (error: unknown) {
                if (error instanceof Error && error.message === "process.exit called") {
                    throw error;
                }
                if (spinner?.isSpinning) {
                    spinner.fail(chalk.red(`TTL check failed: ${error instanceof Error ? error.message : String(error)}`));
                }
                const msg = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
