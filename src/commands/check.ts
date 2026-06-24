import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import { StellarRpcClient } from "../rpc/client.js";

const LOW_TTL_THRESHOLD = 10;

export function registerCheckCommand(program: Command): void {
    program
        .command("check <contractId>")
        .description("Run CI-style checks against a watched contract (can be forced)")
        .option("--force", "Bypass CI TTL failures and exit 0")
        .action(async (contractId: string, options: { force?: boolean }) => {
            const db = getDatabase();
            const contract = getContract(db, contractId);

            if (!contract) {
                console.log(chalk.red(`Contract ${contractId} is not registered.`));
                process.exit(1);
            }

            const entries = getEntriesForContract(db, contractId);

            if (entries.length === 0) {
                console.log(chalk.yellow("No entries tracked for this contract."));
                process.exit(0);
            }

            const client = new StellarRpcClient(contract.network);

            try {
                const entryKeyXdrs = entries.map(e => e.entry_key_xdr);
                const ttls = await client.getEntryTTLs(entryKeyXdrs);

                const low = ttls.entries.some(e => (e.remainingTTL ?? 0) < LOW_TTL_THRESHOLD);

                if (low) {
                    if (options.force) {
                        console.log("WARNING: CI checks bypassed with --force");
                        process.exit(0);
                    }

                    console.log(chalk.red("One or more entries have low TTL — aborting."));
                    process.exit(1);
                }

                console.log(chalk.green("All entries healthy."));
                process.exit(0);
            } catch (err: any) {
                console.log(chalk.red("Error checking TTLs:"), err?.message ?? String(err));
                process.exit(1);
            }
        });
}
