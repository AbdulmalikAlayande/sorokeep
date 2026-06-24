import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import {
    getAllContracts,
    getEntriesForContract,
    getAlertConfigsForContract,
} from "../db/repositories.js";

interface CheckResult {
    totalContracts: number;
    totalEntries: number;
    entriesBelowThreshold: number;
    entriesHealthy: number;
}

function runCheck(): CheckResult {
    const dbPath = process.env.SOROKEEP_DB_PATH;
    const db = getDatabase(dbPath);
    const contracts = getAllContracts(db);

    if (contracts.length === 0) {
        return { totalContracts: 0, totalEntries: 0, entriesBelowThreshold: 0, entriesHealthy: 0 };
    }

    let totalEntries = 0;
    let entriesBelowThreshold = 0;

    for (const contract of contracts) {
        if (contract.last_checked_ledger == null) continue;

        const entries = getEntriesForContract(db, contract.id);
        if (entries.length === 0) continue;

        const alertConfigs = getAlertConfigsForContract(db, contract.id);
        if (alertConfigs.length === 0) continue;

        const maxThreshold = Math.max(...alertConfigs.map(c => c.threshold_ledgers));

        for (const entry of entries) {
            totalEntries++;
            if (entry.live_until_ledger == null) continue;
            const remainingTTL = entry.live_until_ledger - contract.last_checked_ledger;
            if (remainingTTL < maxThreshold) {
                entriesBelowThreshold++;
            }
        }
    }

    return {
        totalContracts: contracts.length,
        totalEntries,
        entriesBelowThreshold,
        entriesHealthy: totalEntries - entriesBelowThreshold,
    };
}

export function registerCheckCommand(program: Command): void {
    program
        .command("check")
        .description("Check TTL health of all watched contracts; exits non-zero if any TTL bounds are crossed")
        .action(() => {
            const result = runCheck();

            console.log();
            console.log(chalk.bold("  TTL Health Check Results"));
            console.log(chalk.dim(`  Contracts: ${result.totalContracts}`));
            console.log(chalk.dim(`  Entries:   ${result.totalEntries}`));

            if (result.totalContracts === 0) {
                console.log(chalk.yellow("  No contracts registered."));
                console.log(chalk.dim("  Run 'sorokeep watch <contractId>' first."));
            }

            if (result.entriesBelowThreshold > 0) {
                console.log(chalk.red(`  ${result.entriesBelowThreshold} entries below TTL threshold(s)`));
            }
            console.log(chalk.green(`  ${result.entriesHealthy} entries healthy`));

            if (result.entriesBelowThreshold > 0) {
                console.log(chalk.red.bold("\n  ✗ TTL bounds crossed — check failed."));
                process.exit(1);
            }

            console.log(chalk.green.bold("\n  ✓ All TTLs are within bounds."));
            process.exit(0);
        });
}
