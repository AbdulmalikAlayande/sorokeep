import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract, upsertExtensionPolicy, getExtensionPolicy, getGuardPolicyHistory } from "../db/repositories.js";
import { simulateExtension, extendEntries, resolveSecretKey } from "../core/extension.js";
import { formatContractID, formatTimeToCloseLedger, formatBytes, formatCpuInsns } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "GuardCommand" });

export function registerGuardCommand(program: Command): void {
    const guard = program
        .command("guard")
        .description("Configure auto-extension policy for a contract, or view policy history");

    // ── guard history ──────────────────────────────────────────────────────────
    guard
        .command("history")
        .description("Show the change log for a contract's guard (auto-extension) policy")
        .requiredOption("--contract <contractId>", "Contract ID to show history for")
        .action(async (options) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, options.contract);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(options.contract)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                const history = getGuardPolicyHistory(db, options.contract);

                if (history.length === 0) {
                    console.log(chalk.dim(`\nNo policy change history found for ${contract.name ?? formatContractID(options.contract)}.`));
                    console.log(chalk.dim("Policy changes are recorded whenever 'sorokeep guard' is run."));
                    return;
                }

                console.log(`\nGuard policy change history for ${chalk.bold(contract.name ?? formatContractID(options.contract))}:`);
                console.log(chalk.dim(`${"─".repeat(80)}`));

                for (const row of history) {
                    const date = row.changed_at.replace("T", " ").replace(/\.\d+Z$/, " UTC");

                    const enabledLabel = (v: number) => v ? chalk.green("ENABLED") : chalk.yellow("DISABLED");
                    const enabledChange = row.old_enabled === null
                        ? `${enabledLabel(row.new_enabled)} (initial)`
                        : row.old_enabled === row.new_enabled
                            ? enabledLabel(row.new_enabled)
                            : `${enabledLabel(row.old_enabled)} → ${enabledLabel(row.new_enabled)}`;

                    const numChange = (oldVal: number | null, newVal: number) =>
                        oldVal === null
                            ? `${newVal.toLocaleString()} ledgers`
                            : oldVal === newVal
                                ? `${newVal.toLocaleString()} ledgers`
                                : `${oldVal.toLocaleString()} → ${newVal.toLocaleString()} ledgers`;

                    console.log(`\n  ${chalk.dim(date)}`);
                    console.log(`  Status:    ${enabledChange}`);
                    console.log(`  Target:    ${numChange(row.old_target_ttl_ledgers, row.new_target_ttl_ledgers)}`);
                    console.log(`  Threshold: ${numChange(row.old_extend_when_below_ledgers, row.new_extend_when_below_ledgers)}`);

                    if (row.new_keypair_public) {
                        console.log(`  Funded by: ${row.new_keypair_public.slice(0, 8)}...${row.new_keypair_public.slice(-4)}`);
                    }
                    if (row.new_keypair_source) {
                        console.log(`  Key source: ${row.new_keypair_source}`);
                    }
                }

                console.log(chalk.dim(`\n${"─".repeat(80)}`));
                console.log(chalk.dim(`  ${history.length} change${history.length === 1 ? "" : "s"} total`));

            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard history command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    // ── guard <contractId>  (policy configure / show) ──────────────────────────
    guard
        .argument("[contractId]", "Contract ID to configure or inspect")
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension", "100000")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers", "20000")
        .option("--keypair <secret>", "Stellar secret key for signing extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--keypair-vault <path>", "HashiCorp Vault secret path (e.g. secret/data/stellar/mykey)")
        .option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
        .option("--dry-run", "Simulate the extension without submitting")
        .option("--disable", "Disable auto-extension for this contract")
        .action(async (contractId: string | undefined, options) => {
            // If no contractId is provided and no subcommand matched, show help
            if (!contractId) {
                guard.help();
                return;
            }

            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
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

                 console.log("DEBUG: options:", JSON.stringify(options));

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
                } else if (options.keypairVault) {
                    keypairSource = `vault:${options.keypairVault}`;
                } else if (options.keypair) {
                    keypairSource = options.keypair;
                }

                if (keypairSource) {
                    secretKey = await resolveSecretKey(keypairSource) ?? undefined;
                    if (!secretKey) {
                        console.error(chalk.red(`Failed to resolve secret key from source: ${keypairSource}`));
                        process.exit(1);
                    }
                }

                // Save policy
                if (options.autoExtend) {
                    if (!keypairSource || !(keypairSource.startsWith("env:") || keypairSource.startsWith("vault:"))) {
                        console.error(chalk.red("--auto-extend requires --keypair-env or --keypair-vault so the daemon can resolve the key at runtime"));
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
                    console.log(chalk.dim("  Run 'sorokeep daemon --network " + contract.network + "' to start monitoring."));
                    return;
                }

                // Dry-run: simulate extension
                if (options.dryRun) {
                    if (!secretKey) {
                        console.error(chalk.red("--keypair, --keypair-env, or --keypair-vault required for dry-run simulation"));
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

                     if (result?.success) {
                         spinner.succeed(chalk.green("Simulation successful"));
                        logger.info("Simulation successful in guard.ts");
                        console.log(`  Entries:       ${result.entriesExtended}`);
                        console.log(`  Estimated fee: ${(result.estimatedFee! / 10_000_000).toFixed(7)} XLM`);
                        console.log(`  CPU:          ${formatCpuInsns(result.cpuInsns!)}`);
                        console.log(`  Memory:       ${formatBytes(result.memBytes!)}`);
                        if (result.readBytes !== undefined) {
                            console.log(`  Read size:    ${formatBytes(result.readBytes)}`);
                        }
                        if (result.writeBytes !== undefined) {
                            console.log(`  Write size:   ${formatBytes(result.writeBytes)}`);
                        }
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
                    if (policy.keypair_source) {
                        console.log(`  Key source: ${policy.keypair_source}`);
                    }
                } else {
                    console.log(chalk.dim("\nNo extension policy configured for this contract."));
                    console.log(chalk.dim("Use --auto-extend with --keypair-env or --keypair-vault to enable auto-extension."));
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
