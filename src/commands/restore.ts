import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import { restoreEntries } from "../core/extension.js";
import { formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "RestoreCommand" });

export function registerRestoreCommand(program: Command): void {
    program
        .command("restore <contractId>")
        .description("Restore archived entries for a contract")
        .option("--keypair <secret>", "Stellar secret key for signing restore transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--entry <keyXdr>", "Specific entry key XDR to restore (can be used multiple times)", collect, [])
        .option("--all", "Restore all tracked entries for the contract")
        .action(async (contractId: string, options) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sentinel watch' first.`));
                    process.exit(1);
                }

                // Resolve secret key
                let secretKey: string | undefined;

                if (options.keypairEnv) {
                    secretKey = process.env[options.keypairEnv];
                    if (!secretKey) {
                        console.error(chalk.red(`Environment variable ${options.keypairEnv} is not set`));
                        process.exit(1);
                    }
                } else if (options.keypair) {
                    secretKey = options.keypair;
                }

                if (!secretKey) {
                    console.error(chalk.red("--keypair or --keypair-env is required for restoration"));
                    process.exit(1);
                }

                // Determine which entries to restore
                let entryKeys: string[];

                if (options.all && options.entry && options.entry.length > 0) {
                    console.error(chalk.red("Use either --entry <keyXdr> or --all, not both"));
                    process.exit(1);
                }

                if (options.entry && options.entry.length > 0) {
                    entryKeys = options.entry;
                } else if (options.all) {
                    const entries = getEntriesForContract(db, contractId);
                    entryKeys = entries.map(e => e.entry_key_xdr);
                } else {
                    console.error(chalk.red("Specify --entry <keyXdr> or --all to select entries to restore"));
                    process.exit(1);
                }

                if (entryKeys.length === 0) {
                    console.log(chalk.yellow("No entries to restore"));
                    return;
                }

                const displayName = contract.name ?? formatContractID(contractId);
                const spinner = ora(`Restoring ${entryKeys.length} entries for ${displayName}...`).start();

                const result = await restoreEntries(db, contractId, entryKeys, secretKey!);

                if (result.success) {
                    spinner.succeed(chalk.green(`Restored ${result.entriesRestored} entries for ${displayName}`));
                    console.log(`  Tx hash: ${result.txHash}`);
                    console.log(`  Ledger:  ${result.ledger}`);
                    console.log(chalk.dim(`\n  Run 'sentinel status ${formatContractID(contractId)}' to verify.`));
                } else {
                    spinner.fail(chalk.red(`Restore failed: ${result.error}`));
                    if (result.txHash) {
                        console.log(`  Tx hash: ${result.txHash}`);
                    }
                    process.exit(1);
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Restore command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}

/**
 * Commander collect helper for repeatable options.
 */
function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}
