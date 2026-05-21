import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database";
import { getContract, getEntriesForContract } from "../db/repositories";
import {
    classifyTTL,
    statusIndicator,
    formatTimeToCloseLedger,
    formatContractID,
} from "../utils/formatting";

export function registerStatusCommand(program: Command): void {
    program
        .command("status <contractId>")
        .description("Show TTL and storage health for a watched contract")
        .action((contractId: string) => {
            const db = getDatabase();
            const contract = getContract(db, contractId);

            if (!contract) {
                console.log(chalk.red(`Contract ${formatContractID(contractId)} is not registered.`));
                console.log(chalk.dim("Run 'sentinel watch <contractId>' first."));
                process.exit(1);
            }

            const entries = getEntriesForContract(db, contractId);
            const displayName = contract.name ?? formatContractID(contractId);
            const lastChecked = contract.last_checked_ledger ?? null;

            console.log();
            console.log(chalk.bold(`  ${displayName}`) + chalk.dim(` (${formatContractID(contractId)})`));
            console.log(`  Network: ${chalk.cyan(contract.network)}`);
            if (lastChecked != null) {
                console.log(chalk.dim(`  Last checked: ledger ${lastChecked.toLocaleString()}`));
            }
            console.log();

            if (entries.length === 0) {
                console.log(chalk.yellow("  No entries tracked for this contract."));
                console.log();
                return;
            }

            // Build labels for each entry — used for display and alignment
            const labels: string[] = entries.map((e) => {
                if (e.entry_type === "instance") return "Instance";
                if (e.entry_type === "wasm") return "WASM Code";
                return e.label ?? e.entry_type;
            });

            const maxLabelLen = Math.max(...labels.map((l) => l.length));

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const label = labels[i];

                // Safety: entries and labels are built from the same source array,
                // but noUncheckedIndexedAccess is enabled, so we guard explicitly.
                if (!entry || !label) continue;

                const paddedLabel = label.padEnd(maxLabelLen);

                if (entry.live_until_ledger == null || lastChecked == null) {
                    console.log(`  ${paddedLabel}  TTL: ${chalk.dim("unknown")}`);
                    continue;
                }

                const remainingTTL = entry.live_until_ledger - lastChecked;
                const status = classifyTTL(remainingTTL);
                const timeStr = formatTimeToCloseLedger(remainingTTL);

                console.log(
                    `  ${paddedLabel}  TTL: ${remainingTTL.toLocaleString().padStart(9)} ledgers (${timeStr})  ${statusIndicator(status)}`,
                );
            }

            console.log();
        });
}
