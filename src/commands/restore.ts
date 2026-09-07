import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract } from "../db/repositories.js";
import { restoreEntries } from "../core/extension.js";
import { formatContractID, printOutput, validateContractId } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";
import { handleRpcUnreachableError } from "../rpc/client.js";

const logger = getLogger().child({ component: "RestoreCommand" });

export function registerRestoreCommand(program: Command): void {
    program
        .command("restore <contractId>")
        .description("Restore archived entries for a contract")
        .option("--keypair <secret>", "Stellar secret key for signing restore transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--entry <keyXdr>", "Specific entry key XDR to restore (can be used multiple times)", collect, [])
        .option("--all", "Restore all tracked entries for the contract")
        .option("--json", "Output machine-readable JSON")
        .action(async (contractId: string, options: { json?: boolean; keypair?: string; keypairEnv?: string; entry?: string[]; all?: boolean } = {}) => {
            let spinner: ReturnType<typeof ora> | undefined;
            try {
                const contractIdValidation = validateContractId(contractId);
                if (!contractIdValidation.valid) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_contract_id", contractId, message: contractIdValidation.reason }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Invalid contract ID: ${contractIdValidation.reason}`));
                    process.exit(1);
                    return;
                }

                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    if (options.json) {
                        printOutput({ success: false, error: "contract_not_found", contractId }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                }

                let secretKey: string | undefined;

                if (options.keypairEnv) {
                    secretKey = process.env[options.keypairEnv];
                    if (!secretKey) {
                        if (options.json) {
                            printOutput({ success: false, error: "missing_keypair_env", contractId, keypairEnv: options.keypairEnv }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red(`Environment variable ${options.keypairEnv} is not set`));
                        process.exit(1);
                    }
                } else if (options.keypair) {
                    secretKey = options.keypair;
                }

                if (!secretKey) {
                    if (options.json) {
                        printOutput({ success: false, error: "missing_keypair", contractId }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--keypair or --keypair-env is required for restoration"));
                    process.exit(1);
                }

                let entryKeys: string[];

                if (options.all && options.entry && options.entry.length > 0) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_selection", contractId, message: "Use either --entry <keyXdr> or --all, not both" }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("Use either --entry <keyXdr> or --all, not both"));
                    process.exit(1);
                }

                if (options.entry && options.entry.length > 0) {
                    entryKeys = options.entry;
                } else if (options.all) {
                    const entries = getEntriesForContract(db, contractId);
                    entryKeys = entries.map(e => e.entry_key_xdr);
                } else {
                    if (options.json) {
                        printOutput({ success: false, error: "missing_selection", contractId, message: "Specify --entry <keyXdr> or --all to select entries to restore" }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("Specify --entry <keyXdr> or --all to select entries to restore"));
                    process.exit(1);
                }

                if (entryKeys.length === 0) {
                    if (options.json) {
                        printOutput({ success: true, contractId, message: "No entries to restore", entriesRestored: 0 }, true);
                        return;
                    }
                    console.log(chalk.yellow("No entries to restore"));
                    return;
                }

                const displayName = contract.name ?? formatContractID(contractId);
                if (options.json) {
                    const result = await restoreEntries(db, contractId, entryKeys, secretKey!);
                    printOutput({
                        ...result,
                        contractId,
                        contractName: displayName,
                        entryCount: entryKeys.length,
                    }, true);
                    if (!result.success) {
                        process.exitCode = 1;
                    }
                    return;
                }
                spinner = ora(`Restoring ${entryKeys.length} entries for ${displayName}...`).start();

                const result = await restoreEntries(db, contractId, entryKeys, secretKey!);

                if (result.success) {
                    spinner.succeed(chalk.green(`Restored ${result.entriesRestored} entries for ${displayName}`));
                    console.log(`  Tx hash:     ${result.txHash}`);
                    console.log(`  Ledger:      ${result.ledger}`);
                    if (result.feeCharged !== undefined) {
                        const feeXlm = (result.feeCharged / 10_000_000).toFixed(7);
                        console.log(`  Fee spent:   ${feeXlm} XLM (${result.feeCharged} stroops)`);
                    }
                    console.log(chalk.dim(`\n  Run 'sorokeep status ${formatContractID(contractId)}' to verify.`));
                } else {
                    spinner.fail(chalk.red(`Restore failed: ${result.error}`));
                    handleRpcUnreachableError(result.error);
                    if (result.txHash) {
                        console.log(`  Tx hash: ${result.txHash}`);
                    }
                    process.exit(1);
                }
            } catch (error: unknown) {
                if (error instanceof Error && error.message === "process.exit called") {
                    throw error;
                }
                const msg = error instanceof Error ? error.message : String(error);
                if (spinner?.isSpinning) {
                    spinner.fail(chalk.red(`Restore failed: ${msg}`));
                }
                logger.error("Restore command failed", { error: msg });
                if (options.json) {
                    printOutput({ success: false, error: msg, contractId }, true);
                    process.exitCode = 1;
                    return;
                }
                if (!handleRpcUnreachableError(error)) {
                    console.error(chalk.red(`Error: ${msg}`));
                }
                process.exit(1);
            }
        });
}

function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}