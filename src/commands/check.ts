import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import {
    classifyTTL,
    statusIndicator,
    formatTimeToCloseLedger,
    formatContractID,
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
            const db = getDatabase();
            const contract = getContract(db, contractId);

            if (!contract) {
                console.log(chalk.red(`Contract ${formatContractID(contractId)} is not registered.`));
                console.log(chalk.dim("Run 'sorokeep watch <contractId>' first."));
                process.exit(1);
            }

            const entries = getEntriesForContract(db, contractId);
            const lastChecked = contract.last_checked_ledger;

            if (entries.length === 0 || lastChecked == null) {
                console.log(chalk.green("All TTLs are safe."));
                process.exit(0);
            }

            let hasFailure = false;

            for (const entry of entries) {
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
                    console.log(
                        `${chalk.bold(label)}  TTL: ${remainingTTL.toLocaleString().padStart(9)} ledgers (${timeStr})  ${statusIndicator(status)}  ${chalk.red("FAIL")}`,
                    );
                } else {
                    console.log(
                        `${chalk.bold(label)}  TTL: ${remainingTTL.toLocaleString().padStart(9)} ledgers (${timeStr})  ${statusIndicator(status)}  ${chalk.green("PASS")}`,
                    );
                }
            }

            if (hasFailure) {
                if (options.force) {
                    console.log("WARNING: CI checks bypassed with --force");
                    process.exit(0);
                } else {
                    process.exit(1);
                }
            }

            console.log(chalk.green("All TTLs are safe."));
            process.exit(0);
        });
}
