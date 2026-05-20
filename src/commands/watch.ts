import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { StellarRpcClient } from "../rpc/client";
import { getDatabase } from "../db/database";
import { insertContract, upsertEntry } from "../db/repositories";
import { getLogger } from "../logging";
import { formatContractID } from "../utils/formatting";

const logger = getLogger().child({ component: 'WatchCommand' });

export const watchCommand = new Command("watch")
    .description("Register and start watching a contract")
    .argument("<contract-id>", "The Soroban contract ID (C...)")
    .option("-n, --name <name>", "A human-readable name for the contract")
    .option("--network <network>", "The network to use (testnet, mainnet)", "testnet")
    .option("-r, --rpc-url <url>", "Custom RPC URL")
    .option("--storage-keys <keys>", "Comma-separated base64 XDR storage keys to watch")
    .action(async (contractId, options) => {
        const spinner = ora(`Registering contract ${formatContractID(contractId)}...`).start();
        
        try {
            const client = new StellarRpcClient(options.network, options.rpcUrl);
            const db = getDatabase();
            
            logger.debug(`Watching contract ${contractId} on ${options.network}`);

            // 1. Fetch Contract Instance
            spinner.text = "Fetching contract instance...";
            const instanceEntry = await client.getContractInstanceEntry(contractId);
            
            if (!instanceEntry) {
                spinner.fail(chalk.red(`Contract ${contractId} not found on ${options.network}.`));
                return;
            }

            // 2. Save Contract to DB
            insertContract(db, {
                id: contractId,
                name: options.name,
                network: options.network,
                wasm_hash: instanceEntry.wasmHash ?? undefined,
            });

            // 3. Save Instance Entry
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: instanceEntry.entryKeyXdr,
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: instanceEntry.liveUntilLedgerSeq,
                last_modified_ledger: instanceEntry.lastModifiedLedgerSeq,
                discovery_source: "manual",
            });

            // 4. If WASM exists, fetch and save WASM Entry
            if (instanceEntry.wasmHash) {
                spinner.text = "Fetching WASM entry...";
                const wasmEntry = await client.getWasmCodeEntry(instanceEntry.wasmHash);
                if (wasmEntry) {
                    upsertEntry(db, {
                        contract_id: contractId,
                        entry_key_xdr: wasmEntry.entryKeyXdr,
                        entry_type: "wasm",
                        label: "WASM Code",
                        live_until_ledger: wasmEntry.liveUntilLedgerSeq,
                        last_modified_ledger: wasmEntry.lastModifiedLedgerSeq,
                        discovery_source: "instance_scan",
                    });
                }
            }

            // 5. If manual storage keys provided, fetch and save them
            if (options.storageKeys) {
                const keys = options.storageKeys.split(",").map((k: string) => k.trim());
                spinner.text = `Fetching ${keys.length} storage entries...`;
                const ttls = await client.getEntryTTLs(keys);
                
                for (const entry of ttls.entries) {
                    upsertEntry(db, {
                        contract_id: contractId,
                        entry_key_xdr: entry.entryKeyXdr,
                        entry_type: "persistent", // Defaulting to persistent for manual keys for now
                        label: "Manual Storage Entry",
                        live_until_ledger: entry.liveUntilLedgerSeq,
                        last_modified_ledger: entry.lastModifiedLedgerSeq,
                        discovery_source: "manual",
                    });
                }
            }

            spinner.succeed(chalk.green(`Contract ${options.name || formatContractID(contractId)} registered successfully.`));
            console.log(chalk.gray(`Network: ${options.network}`));
            console.log(chalk.gray(`Entries indexed: ${options.storageKeys ? 2 + options.storageKeys.split(",").length : 2}`));

        } catch (error: any) {
            spinner.fail(chalk.red(`Failed to watch contract: ${error.message}`));
            logger.error("Watch command failed", error);
        }
    });