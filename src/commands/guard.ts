import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract, upsertExtensionPolicy, getExtensionPolicy } from "../db/repositories.js";
import { simulateExtension, extendEntries } from "../core/extension.js";
import { formatContractID, formatTimeToCloseLedger } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "GuardCommand" });

export function registerGuardCommand(program: Command): void {
    program
        .command("guard <contractId>")
        .description("Configure auto-extension policy for a contract")
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension", "100000")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers", "20000")
        .option("--keypair <secret>", "Stellar secret key for signing extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
        .option("--dry-run", "Simulate the extension without submitting")
        .option("--disable", "Disable auto-extension for this contract")
        .action(async (contractId: string, options) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sentinel watch' first.`));
                    process.exit(1);
                }

                const targetTTL = parseInt(options.targetTtl, 10);
                const threshold = parseInt(options.threshold, 10);

                if (isNaN(targetTTL) || targetTTL <= 0) {
                    console.error(chalk.red("--target-ttl must be a positive number"));
                    process.exit(1);
                }

                if (isNaN(threshold) || threshold <= 0) {
                    console.error(chalk.red("--threshold must be a positive number"));
                    process.exit(1);
                }

                if (threshold >= targetTTL) {
                    console.error(chalk.red("--threshold must be less than --target-ttl"));
                    process.exit(1);
                }

                // Handle --disable
                if (options.disable) {
                    upsertExtensionPolicy(db, {
                        contract_id: contractId,
                        enabled: false,
                        target_ttl_ledgers: targetTTL,
                        extend_when_below_ledgers: threshold,
                    });
                    console.log(chalk.yellow(`Auto-extension disabled for ${contract.name ?? formatContractID(contractId)}`));
                    return;
                }

                // Resolve keypair source
                let keypairSource: string | undefined;
                let secretKey: string | undefined;

                if (options.keypairEnv) {
                    keypairSource = `env:${options.keypairEnv}`;
                    secretKey = process.env[options.keypairEnv];
                    if (!secretKey) {
                        console.error(chalk.red(`Environment variable ${options.keypairEnv} is not set`));
                        process.exit(1);
                    }
                } else if (options.keypair) {
                    keypairSource = options.keypair;
                    secretKey = options.keypair;
                }

                // Save policy
                if (options.autoExtend) {
                    if (!options.keypairEnv) {
                        console.error(chalk.red("--auto-extend requires --keypair-env so the daemon can resolve the key at runtime"));
                        process.exit(1);
                    }

                    // Extract public key from secret for storage (never store the secret itself)
                    const { Keypair } = await import("@stellar/stellar-sdk");
                    const kp = Keypair.fromSecret(secretKey!);

                    upsertExtensionPolicy(db, {
                        contract_id: contractId,
                        enabled: true,
                        target_ttl_ledgers: targetTTL,
                        extend_when_below_ledgers: threshold,
                        keypair_public: kp.publicKey(),
                        keypair_source: keypairSource!,
                    });

                    console.log(chalk.green(`\nAuto-extension enabled for ${contract.name ?? formatContractID(contractId)}`));
                    console.log(`  Target TTL:  ${targetTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(targetTTL)})`);
                    console.log(`  Threshold:   ${threshold.toLocaleString()} ledgers (${formatTimeToCloseLedger(threshold)})`);
                    console.log(`  Funded by:   ${kp.publicKey().slice(0, 8)}...${kp.publicKey().slice(-4)}`);
                    console.log(chalk.dim("\n  The daemon will auto-extend when TTL drops below the threshold."));
                    console.log(chalk.dim("  Run 'sentinel daemon --network " + contract.network + "' to start monitoring."));
                    return;
                }

                // Dry-run: simulate extension
                if (options.dryRun) {
                    if (!secretKey) {
                        console.error(chalk.red("--keypair or --keypair-env required for dry-run simulation"));
                        process.exit(1);
                    }

                    const entries = getEntriesForContract(db, contractId);
                    if (entries.length === 0) {
                        console.log(chalk.yellow("No entries to extend"));
                        return;
                    }

                    const spinner = ora("Simulating extension...").start();
                    const { Keypair } = await import("@stellar/stellar-sdk");
                    const kp = Keypair.fromSecret(secretKey);

                    const result = await simulateExtension(
                        db,
                        contractId,
                        entries.map(e => e.entry_key_xdr),
                        targetTTL,
                        kp.publicKey(),
                    );

                    if (result.success) {
                        spinner.succeed(chalk.green("Simulation successful"));
                        console.log(`  Entries:       ${result.entriesExtended}`);
                        console.log(`  Estimated fee: ${(result.estimatedFee! / 10_000_000).toFixed(7)} XLM`);
                    } else {
                        spinner.fail(chalk.red(`Simulation failed: ${result.error}`));
                    }
                    return;
                }

                // One-time manual extension
                if (secretKey) {
                    const entries = getEntriesForContract(db, contractId);
                    if (entries.length === 0) {
                        console.log(chalk.yellow("No entries to extend"));
                        return;
                    }

                    const spinner = ora("Extending TTL...").start();
                    const result = await extendEntries(
                        db,
                        contractId,
                        entries.map(e => e.entry_key_xdr),
                        targetTTL,
                        secretKey,
                    );

                    if (result.success) {
                        spinner.succeed(chalk.green("TTL extended successfully"));
                        console.log(`  Entries:  ${result.entriesExtended}`);
                        console.log(`  Tx hash:  ${result.txHash}`);
                        console.log(`  Ledger:   ${result.ledger}`);
                    } else {
                        spinner.fail(chalk.red(`Extension failed: ${result.error}`));
                        process.exit(1);
                    }
                    return;
                }

                // No keypair provided — just show current policy
                const policy = getExtensionPolicy(db, contractId);
                if (policy) {
                    console.log(`\nExtension policy for ${contract.name ?? formatContractID(contractId)}:`);
                    console.log(`  Status:    ${policy.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`);
                    console.log(`  Target:    ${policy.target_ttl_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.target_ttl_ledgers)})`);
                    console.log(`  Threshold: ${policy.extend_when_below_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.extend_when_below_ledgers)})`);
                    if (policy.keypair_public) {
                        console.log(`  Funded by: ${policy.keypair_public.slice(0, 8)}...${policy.keypair_public.slice(-4)}`);
                    }
                } else {
                    console.log(chalk.dim("\nNo extension policy configured for this contract."));
                    console.log(chalk.dim("Use --auto-extend with --keypair to enable auto-extension."));
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
