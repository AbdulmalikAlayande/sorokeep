import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract, upsertExtensionPolicy, getExtensionPolicy } from "../db/repositories.js";
import { simulateExtension, extendEntries, resolveSecretKey } from "../core/extension.js";
import { formatContractID, formatTimeToCloseLedger, formatBytes, formatCpuInsns } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";
import type Database from "better-sqlite3";

const logger = getLogger().child({ component: "GuardCommand" });

/**
 * Exported extension policy shape - safe for serialization to JSON.
 * Per SECURITY.md: Never contains raw secret keys, only public keys and
 * env:/vault: references.
 */
export interface ExportedExtensionPolicy {
    contract_id: string;
    enabled: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public: string | null;
    keypair_source: string | null;
}

/**
 * Export an extension policy to a JSON-serializable object.
 * SECURITY: Never exports raw secret keys - only public keys and env:/vault: references.
 * 
 * @param db - Database connection
 * @param contractId - Contract ID to export policy from
 * @returns Exported policy object safe for JSON serialization
 * @throws Error if no policy exists for the contract
 */
export function exportExtensionPolicy(db: Database.Database, contractId: string): ExportedExtensionPolicy {
    const policy = getExtensionPolicy(db, contractId);
    
    if (!policy) {
        throw new Error(`No extension policy found for contract ${contractId}`);
    }

    // Return only the fields safe for export (no id, no created_at, no secret keys)
    return {
        contract_id: policy.contract_id,
        enabled: Boolean(policy.enabled),
        target_ttl_ledgers: policy.target_ttl_ledgers,
        extend_when_below_ledgers: policy.extend_when_below_ledgers,
        keypair_public: policy.keypair_public,
        keypair_source: policy.keypair_source,
    };
}

/**
 * Import an extension policy from an exported JSON object.
 * SECURITY: Validates that no raw secret keys are present in the import.
 * Only env: and vault: references are allowed for keypair_source.
 * 
 * @param db - Database connection
 * @param targetContractId - Contract ID to apply the policy to
 * @param exported - Exported policy object (from exportExtensionPolicy or JSON)
 * @throws Error if validation fails or if the import contains forbidden fields
 */
export function importExtensionPolicy(
    db: Database.Database,
    targetContractId: string,
    exported: ExportedExtensionPolicy
): void {
    // SECURITY: Check for forbidden secret key fields
    const forbiddenFields = ['keypair_secret', 'secret_key', 'private_key', 'keypair_private'];
    for (const field of forbiddenFields) {
        if (field in exported) {
            throw new Error(`Import contains forbidden secret key field: ${field}`);
        }
    }

    // Validate required fields
    if (typeof exported.enabled !== 'boolean') {
        throw new Error('Missing required field: enabled');
    }
    if (typeof exported.target_ttl_ledgers !== 'number') {
        throw new Error('Missing required field: target_ttl_ledgers');
    }
    if (typeof exported.extend_when_below_ledgers !== 'number') {
        throw new Error('Missing required field: extend_when_below_ledgers');
    }

    // Validate numeric constraints
    if (exported.target_ttl_ledgers <= 0) {
        throw new Error('target_ttl_ledgers must be a positive number');
    }
    if (exported.extend_when_below_ledgers <= 0) {
        throw new Error('extend_when_below_ledgers must be a positive number');
    }
    if (exported.extend_when_below_ledgers >= exported.target_ttl_ledgers) {
        throw new Error('extend_when_below_ledgers must be less than target_ttl_ledgers');
    }

    // Validate keypair fields are both present or both null
    const hasPublic = exported.keypair_public !== null && exported.keypair_public !== undefined;
    const hasSource = exported.keypair_source !== null && exported.keypair_source !== undefined;
    
    if (hasPublic !== hasSource) {
        throw new Error('keypair_public and keypair_source must both be present or both null');
    }

    // SECURITY: If keypair_source is present, it must be an env: or vault: reference
    if (exported.keypair_source) {
        if (!exported.keypair_source.startsWith('env:') && !exported.keypair_source.startsWith('vault:')) {
            throw new Error('keypair_source must be an env: or vault: reference, not a raw secret key');
        }
    }

    // Validate keypair_public format if present
    if (exported.keypair_public) {
        // Stellar public keys start with 'G' and are 56 characters long
        if (!exported.keypair_public.match(/^G[A-Z0-9]{55}$/)) {
            throw new Error('keypair_public must be a valid Stellar public key (starts with G, 56 chars)');
        }
    }

    // Import the policy (overwrites existing if present)
    upsertExtensionPolicy(db, {
        contract_id: targetContractId, // Use target contract, not the one in export
        enabled: exported.enabled,
        target_ttl_ledgers: exported.target_ttl_ledgers,
        extend_when_below_ledgers: exported.extend_when_below_ledgers,
        keypair_public: exported.keypair_public ?? undefined,
        keypair_source: exported.keypair_source ?? undefined,
    });
}

export function registerGuardCommand(program: Command): void {
    const guardCommand = program
        .command("guard <contractId>")
        .description("Configure auto-extension policy for a contract")
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension", "100000")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers", "20000")
        .option("--keypair <secret>", "Stellar secret key for signing extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--keypair-vault <path>", "HashiCorp Vault secret path (e.g. secret/data/stellar/mykey)")
        .option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
        .option("--dry-run", "Simulate the extension without submitting")
        .option("--disable", "Disable auto-extension for this contract")
        .action(async (contractId: string, options) => {
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

    // guard export subcommand
    guardCommand
        .command("export")
        .description("Export extension policy to JSON")
        .argument("<contractId>", "Contract ID to export policy from")
        .option("--out <file>", "Output file path (default: stdout)")
        .action(async (contractId: string, options: { out?: string }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                }

                const exported = exportExtensionPolicy(db, contractId);
                const json = JSON.stringify(exported, null, 2);

                if (options.out) {
                    const fs = await import("fs/promises");
                    await fs.writeFile(options.out, json + "\n", "utf-8");
                    console.log(chalk.green(`Extension policy exported to ${options.out}`));
                } else {
                    console.log(json);
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard export failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    // guard import subcommand
    guardCommand
        .command("import")
        .description("Import extension policy from JSON")
        .argument("<contractId>", "Target contract ID to apply policy to")
        .option("--file <path>", "Input file path (default: stdin)")
        .action(async (contractId: string, options: { file?: string }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                }

                let jsonContent: string;
                if (options.file) {
                    const fs = await import("fs/promises");
                    jsonContent = await fs.readFile(options.file, "utf-8");
                } else {
                    // Read from stdin
                    const chunks: Buffer[] = [];
                    process.stdin.setEncoding("utf-8");
                    for await (const chunk of process.stdin) {
                        chunks.push(Buffer.from(chunk, "utf-8"));
                    }
                    jsonContent = Buffer.concat(chunks).toString("utf-8");
                }

                const parsed = JSON.parse(jsonContent);
                importExtensionPolicy(db, contractId, parsed);

                console.log(chalk.green(`Extension policy imported successfully for ${contract.name ?? formatContractID(contractId)}`));
                
                // Show the imported policy
                const imported = getExtensionPolicy(db, contractId);
                if (imported) {
                    console.log(`  Status:    ${imported.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`);
                    console.log(`  Target:    ${imported.target_ttl_ledgers.toLocaleString()} ledgers`);
                    console.log(`  Threshold: ${imported.extend_when_below_ledgers.toLocaleString()} ledgers`);
                    if (imported.keypair_public) {
                        console.log(`  Funded by: ${imported.keypair_public.slice(0, 8)}...${imported.keypair_public.slice(-4)}`);
                    }
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard import failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
