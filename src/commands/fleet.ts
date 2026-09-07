import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getAllContracts, getEntriesForContract } from "../db/repositories.js";
import {
    classifyTTL,
    statusIndicator,
    formatContractID,
    paginateList,
    formatPaginationFooter,
    formatFleetCSV,
    type TTLStatus,
} from "../utils/formatting.js";

function severityOrder(s: TTLStatus): number {
    switch (s) {
        case "expired": return 0;
        case "critical": return 1;
        case "warning": return 2;
        case "ok": return 3;
    }
}

export function registerFleetCommand(program: Command): void {
    program
        .command("fleet status")
        .description("Show aggregate health dashboard across all watched contracts")
        .option("--page <n>", "Page number", "1")
        .option("--page-size <n>", "Items per page", "25")
        .option("--format <format>", "Output format: table, csv", "table")
        .action((_status: string, options: { page?: string; pageSize?: string; format?: string } = {}) => {
            const db = getDatabase();
            const contracts = getAllContracts(db);

            if (contracts.length === 0) {
                console.log();
                console.log(chalk.yellow("  No contracts are being watched."));
                console.log(chalk.dim("  Run 'sorokeep watch <contractId>' first."));
                console.log();
                return;
            }

            // Compute worst-case TTL severity per contract
            const contractStatuses = contracts.map((contract) => {
                const entries = getEntriesForContract(db, contract.id);
                const lastChecked = contract.last_checked_ledger;

                let worstStatus: TTLStatus = "ok";

                for (const entry of entries) {
                    if (entry.live_until_ledger == null || lastChecked == null) continue;
                    const remainingTTL = entry.live_until_ledger - lastChecked;
                    const status = classifyTTL(remainingTTL);

                    if (severityOrder(status) < severityOrder(worstStatus)) {
                        worstStatus = status;
                    }
                }

                // If there are no entries tracked yet, default to "ok"
                // (the contract was registered but hasn't been polled yet)
                if (entries.length === 0) {
                    worstStatus = "ok";
                }

                return {
                    id: contract.id,
                    name: contract.name,
                    network: contract.network,
                    status: worstStatus,
                };
            });

            // ── CSV format ─────────────────────────────────────────────
            const format = options.format ?? "table";
            if (format === "csv") {
                const csvRows: Array<{
                    contractId: string;
                    contractName: string | null;
                    entryKeyXdr: string;
                    entryType: string;
                    remainingTTL: number;
                    status: string;
                }> = [];

                for (const contract of contracts) {
                    const entries = getEntriesForContract(db, contract.id);
                    const lastChecked = contract.last_checked_ledger;

                    for (const entry of entries) {
                        let remainingTTL = 0;
                        let status = "ok";

                        if (entry.live_until_ledger != null && lastChecked != null) {
                            remainingTTL = entry.live_until_ledger - lastChecked;
                            status = classifyTTL(remainingTTL);
                        }

                        csvRows.push({
                            contractId: contract.id,
                            contractName: contract.name,
                            entryKeyXdr: entry.entry_key_xdr,
                            entryType: entry.entry_type,
                            remainingTTL,
                            status,
                        });
                    }
                }

                console.log(formatFleetCSV(csvRows));
                return;
            }

            // Summary: count contracts by severity (ordered worst → best)
            const counts: Record<TTLStatus, number> = {
                expired: 0,
                critical: 0,
                warning: 0,
                ok: 0,
            };

            for (const cs of contractStatuses) {
                counts[cs.status]++;
            }

            // ── Render ──────────────────────────────────────────────────
            console.log();
            console.log(chalk.bold(`  Fleet Health Summary`));
            console.log(
                `  ${chalk.bold.magenta("EXPIRED")}: ${counts.expired}  ` +
                `${chalk.bold.red("CRITICAL")}: ${counts.critical}  ` +
                `${chalk.bold.yellow("WARNING")}: ${counts.warning}  ` +
                `${chalk.bold.green("OK")}: ${counts.ok}`,
            );
            console.log();

            // ── Per-contract rows ───────────────────────────────────────
            const maxNameLen = Math.max(
                ...contractStatuses.map((c) => (c.name ?? formatContractID(c.id)).length),
                10,
            );

            const page = parseInt(options.page ?? "1", 10);
            const pageSize = parseInt(options.pageSize ?? "25", 10);
            const result = paginateList(contractStatuses, page, pageSize);

            console.log(`  ${chalk.bold("Contract".padEnd(maxNameLen))}  ${chalk.bold("Network".padEnd(8))}  ${chalk.bold("Status")}`);
            console.log(`  ${"─".repeat(maxNameLen + 2 + 8 + 2 + 10)}`);

            for (const cs of result.items) {
                const displayName = cs.name ?? formatContractID(cs.id);
                const paddedName = displayName.padEnd(maxNameLen);
                console.log(
                    `  ${paddedName}  ${chalk.dim(cs.network.padEnd(8))}  ${statusIndicator(cs.status)}`,
                );
            }

            console.log();
            console.log(chalk.dim(`  ${formatPaginationFooter(result.meta)}`));
            console.log();
        });
}
