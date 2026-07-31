import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract, upsertExtensionPolicy, getExtensionPolicy } from "../db/repositories.js";
import { rollbackExtensionPolicy } from "../db/guard_policy_history.js";
import { simulateExtension, extendEntries, resolveSecretKey } from "../core/extension.js";
import { formatContractID, formatTimeToCloseLedger, formatBytes, formatCpuInsns } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "GuardCommand" });

export function registerGuardCommand(program: Command): void {
    const guard = program
        .command("guard [contractId]")
        .description("Configure auto-extension policy for a contract")
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension", "100000")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers", "20000")
        .option("--keypair <secret>", "Stellar secret key for signing extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--keypair-vault <path>", "HashiCorp Vault secret path (e.g. secret/data/stellar/mykey)")
        .option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
        .option("--dry-run", "Simulate the extension without submitting")
        .option("--disable", "Disable auto-extension for this contract");

    // Register subcommands before the parent action. This also ensures that
    // consumers which inspect the parent action receive the guard handler.
    guard
        .command("rollback")
        .description("Roll back an extension policy to a previous historical version")
        .requiredOption("--contract <id>", "The contract ID to roll back")
        .option("--to <history-id>", "Historical policy version ID")
        .action((options: { contract: string; to?: string }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, options.contract);
                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(options.contract)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                let historyId: number | undefined;
                if (options.to !== undefined) {
                    historyId = Number.parseInt(options.to, 10);
                    if (!Number.isInteger(historyId) || historyId <= 0) {
                        console.error(chalk.red("--to must be a positive history ID."));
                        process.exit(1);
                        return;
                    }
                }

                const restored = rollbackExtensionPolicy(db, options.contract, historyId);
                console.log(chalk.green(`Extension policy rolled back for ${contract.name ?? formatContractID(options.contract)}.`));
                console.log(`  Restored history ID: ${restored.id}`);
                console.log(`  Target TTL:          ${restored.target_ttl_ledgers.toLocaleString()} ledgers`);
                console.log(`  Threshold:           ${restored.extend_when_below_ledgers.toLocaleString()} ledgers`);
                console.log(chalk.dim("  Rollback recorded as a new policy history entry."));
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard.action(async (contractId: string | undefined, options) => {
        if (!contractId) {
            console.error(chalk.red("A contract ID is required."));
            process.exit(1);
            return;
        }

        try {
            const db = getDatabase();
            const contract = getContract(db, contractId);
            if (!contract) {
                console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                process.exit(1);
                return;
            }

            const targetTTL = parseInt(options.targetTtl, 10);
            const threshold = parseInt(options.threshold, 10);
            if (isNaN(targetTTL) || targetTTL <= 0) {
                console.error(chalk.red("--target-ttl must be a positive number"));
                process.exit(1);
                return;
            }
            if (isNaN(threshold) || threshold <= 0) {
                console.error(chalk.red("--threshold must be a positive number"));
                process.exit(1);
                return;
            }
            if (threshold >= targetTTL) {
                console.error(chalk.red("--threshold must be less than --target-ttl"));
                process.exit(1);
                return;
            }

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

            let keypairSource: string | undefined;
            let secretKey: string | undefined;
            if (options.keypairEnv) keypairSource = `env:${options.keypairEnv}`;
            else if (options.keypairVault) keypairSource = `vault:${options.keypairVault}`;
            else if (options.keypair) keypairSource = options.keypair;

            if (keypairSource) {
                secretKey = await resolveSecretKey(keypairSource) ?? undefined;
                if (!secretKey) {
                    console.error(chalk.red(`Failed to resolve secret key from source: ${keypairSource}`));
                    process.exit(1);
                    return;
                }
            }

            if (options.autoExtend) {
                if (!keypairSource || !(keypairSource.startsWith("env:") || keypairSource.startsWith("vault:"))) {
                    console.error(chalk.red("--auto-extend requires --keypair-env or --keypair-vault so the daemon can resolve the key at runtime"));
                    process.exit(1);
                    return;
                }

                const { Keypair } = await import("@stellar/stellar-sdk");
                const kp = Keypair.fromSecret(secretKey!);
                upsertExtensionPolicy(db, {
                    contract_id: contractId,
                    enabled: true,
                    target_ttl_ledgers: targetTTL,
                    extend_when_below_ledgers: threshold,
                    keypair_public: kp.publicKey(),
                    keypair_source: keypairSource,
                });

                console.log(chalk.green(`\nAuto-extension enabled for ${contract.name ?? formatContractID(contractId)}`));
                console.log(`  Target TTL:  ${targetTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(targetTTL)})`);
                console.log(`  Threshold:   ${threshold.toLocaleString()} ledgers (${formatTimeToCloseLedger(threshold)})`);
                console.log(`  Funded by:   ${kp.publicKey().slice(0, 8)}...${kp.publicKey().slice(-4)}`);
                console.log(chalk.dim("\n  The daemon will auto-extend when TTL drops below the threshold."));
                console.log(chalk.dim("  Run 'sorokeep daemon --network " + contract.network + "' to start monitoring."));
                return;
            }

            if (options.dryRun) {
                if (!secretKey) {
                    console.error(chalk.red("--keypair, --keypair-env, or --keypair-vault required for dry-run simulation"));
                    process.exit(1);
                    return;
                }

                const entries = getEntriesForContract(db, contractId);
                if (entries.length === 0) {
                    console.log(chalk.yellow("No entries to extend"));
                    return;
                }

                const spinner = ora("Simulating extension...").start();
                const { Keypair } = await import("@stellar/stellar-sdk");
                const result = await simulateExtension(
                    db,
                    contractId,
                    entries.map((entry) => entry.entry_key_xdr),
                    targetTTL,
                    Keypair.fromSecret(secretKey).publicKey(),
                );

                if (result?.success) {
                    spinner.succeed(chalk.green("Simulation successful"));
                    logger.info("Simulation successful in guard.ts");
                    console.log(`  Entries:       ${result.entriesExtended}`);
                    console.log(`  Estimated fee: ${(result.estimatedFee! / 10_000_000).toFixed(7)} XLM`);
                    console.log(`  CPU:          ${formatCpuInsns(result.cpuInsns!)}`);
                    console.log(`  Memory:       ${formatBytes(result.memBytes!)}`);
                    if (result.readBytes !== undefined) console.log(`  Read size:    ${formatBytes(result.readBytes)}`);
                    if (result.writeBytes !== undefined) console.log(`  Write size:   ${formatBytes(result.writeBytes)}`);
                } else {
                    spinner.fail(chalk.red(`Simulation failed: ${result.error}`));
                }
                return;
            }

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
                    entries.map((entry) => entry.entry_key_xdr),
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

            const policy = getExtensionPolicy(db, contractId);
            if (!policy) {
                console.log(chalk.dim("\nNo extension policy configured for this contract."));
                console.log(chalk.dim("Use --auto-extend with --keypair-env or --keypair-vault to enable auto-extension."));
                return;
            }

            console.log(`\nExtension policy for ${contract.name ?? formatContractID(contractId)}:`);
            console.log(`  Status:    ${policy.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`);
            console.log(`  Target:    ${policy.target_ttl_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.target_ttl_ledgers)})`);
            console.log(`  Threshold: ${policy.extend_when_below_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.extend_when_below_ledgers)})`);
            if (policy.keypair_public) console.log(`  Funded by: ${policy.keypair_public.slice(0, 8)}...${policy.keypair_public.slice(-4)}`);
            if (policy.keypair_source) console.log(`  Key source: ${policy.keypair_source}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error("Guard command failed", { error: msg });
            console.error(chalk.red(`Error: ${msg}`));
            process.exit(1);
        }
    });
}
