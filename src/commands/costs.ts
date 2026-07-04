import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getExtensionCosts, calculateFeeAdjustedProjection } from "../core/costs.js";
import { getEntriesForContract } from "../db/repositories.js";
import {
    projectRentWindows,
    DEFAULT_FEE_PER_RENT_1KB,
} from "../core/rent_projection.js";
import type { RentWindowsResult } from "../core/rent_projection.js";
import { StellarRpcClient } from "../rpc/client.js";
import { formatContractID } from "../utils/formatting.js";
import { loadConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "CostsCommand" });

/**
 * Fallback entry size when mem_bytes is not recorded for any extension of
 * an entry. 1 KB is the smallest meaningful allocation for a Soroban entry
 * and keeps projections conservative.
 */
const DEFAULT_ENTRY_SIZE_BYTES = 1024;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Render a single RentWindowsResult as a table under the "Forecasted Rent"
 * section. Returns an array of console lines (without printing) so callers can
 * test the output easily.
 *
 * @param result    - Output of `projectRentWindows` for one entry.
 * @param entryType - Human-readable entry type label (instance, wasm, …).
 * @param budget    - Monthly budget in XLM (optional). When provided, windows
 *                    that exceed the budget are flagged in red.
 */
export function formatForecastedRentEntry(
    result: RentWindowsResult,
    entryType: string,
    budget?: number,
): string[] {
    const lines: string[] = [];
    lines.push(`    ${chalk.dim("Entry type:")} ${entryType}`);

    for (const window of result.windows) {
        const xlm = window.estimatedFeeXlm.toFixed(7);
        const overBudget = budget !== undefined && window.estimatedFeeXlm > budget;
        const budgetFlag = overBudget
            ? " " + chalk.bold.red(`⚠ OVER BUDGET (limit: ${budget.toFixed(7)} XLM)`)
            : "";

        const dayLabel = `${window.days}-day`;
        const costStr = overBudget
            ? chalk.red(`~${xlm} XLM`)
            : chalk.cyan(`~${xlm} XLM`);

        lines.push(`      ${chalk.bold(dayLabel)}: ${costStr}${budgetFlag}`);
    }

    return lines;
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerCostsCommand(program: Command): void {
    program
        .command("costs <contractId>")
        .description("Show rent costs and extension history for a contract")
        .option("--period <days>", "Show costs for the last N days", "30")
        .option("--all", "Show all extension history")
        .option("--json", "Output machine-readable JSON")
        .option(
            "--monthly-budget <xlm>",
            "Monthly budget in XLM — highlight forecast windows that exceed this limit",
        )
        .action(async (contractId: string, options: { period?: string; all?: boolean; json?: boolean; monthlyBudget?: string } = {}) => {
            options = options || {};
            try {
                const db = getDatabase();
                const days = options.all ? undefined : parseInt(options.period, 10);

                if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
                    if (options.json) {
                        console.log(JSON.stringify({
                            success: false,
                            error: "invalid_period",
                            period: options.period,
                        }));
                    } else {
                        console.error(chalk.red("--period must be a positive integer number of days"));
                    }
                    process.exit(1);
                    return;
                }

                // Resolve monthly budget: CLI flag > config file
                const config = loadConfig();
                let monthlyBudget: number | undefined;
                if (options.monthlyBudget !== undefined) {
                    const parsed = parseFloat(options.monthlyBudget);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                        if (options.json) {
                            console.log(JSON.stringify({
                                success: false,
                                error: "invalid_monthly_budget",
                                monthlyBudget: options.monthlyBudget,
                            }));
                        } else {
                            console.error(chalk.red("--monthly-budget must be a positive number"));
                        }
                        process.exit(1);
                        return;
                    }
                    monthlyBudget = parsed;
                } else {
                    monthlyBudget = config.monthlyBudgetXlm;
                }

                const result = getExtensionCosts(
                    db,
                    contractId,
                    options.all ? { all: true } : { period: days },
                );

                if (!result.success) {
                    if (options.json) {
                        console.log(JSON.stringify(result));
                    } else if (result.error === "contract_not_found") {
                        console.error(
                            chalk.red(
                                `Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`,
                            ),
                        );
                    } else {
                        console.error(chalk.red("An error occurred computing extension costs."));
                    }
                    process.exit(1);
                    return;
                }

                const { data } = result;

                if (options.json) {
                    console.log(JSON.stringify(data, null, 2));
                    return;
                }

                const displayName = data.contract.name ?? formatContractID(contractId);

                console.log(
                    `\n${chalk.bold("Extension History")} — ${chalk.cyan(displayName)} (${data.period.label})`,
                );
                console.log(`  Network: ${chalk.cyan(data.contract.network)}`);

                if (data.message) {
                    console.log(chalk.dim(`\n  ${data.message}`));
                    return;
                }

                console.log(`\n  ${chalk.bold("Summary")}`);
                console.log(`  Total extensions: ${chalk.cyan(data.summary.totalExtensions.toString())}`);
                console.log(`  Total cost:       ${chalk.cyan(data.summary.totalCostXlm.toFixed(7))} XLM`);

                console.log(`\n  ${chalk.bold("By Entry Type")}`);
                for (const [type, entryData] of Object.entries(data.byEntryType)) {
                    console.log(
                        `    ${type}: ${entryData.count} extensions (${entryData.costXlm.toFixed(7)} XLM)`,
                    );
                }

                if (days && data.summary.totalExtensions > 0) {
                    let feeStats;
                    try {
                        feeStats = await new StellarRpcClient(data.contract.network).getFeeStats();
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        logger.warn("Unable to fetch live fee stats; using historical projection", { error: message });
                    }

                    const projection = calculateFeeAdjustedProjection(data.summary.totalCostXlm, days, feeStats);
                    console.log(`\n  ${chalk.bold("Projection")}`);
                    console.log(`  Estimated 30-day cost: ~${chalk.cyan(projection.adjustedProjectedCostXlm.toFixed(7))} XLM`);
                    if (feeStats) {
                        console.log(`  Live base fee:     ${chalk.cyan(feeStats.baseFeeStroops.toString())} stroops`);
                        console.log(`  Surge multiplier:  ${chalk.cyan(`${projection.surgePricingMultiplier.toFixed(2)}x`)}`);
                    }

                    // ── Forecasted Rent (30/60/90-day windows per entry) ──────────
                    const entries = getEntriesForContract(db, contractId);

                    // Build a map of entry_type → max observed mem_bytes from
                    // recent extensions. Falls back to DEFAULT_ENTRY_SIZE_BYTES
                    // when no size information is available.
                    const sizeByEntryType = new Map<string, number>();
                    for (const record of data.recentExtensions) {
                        // recentExtensions carries the entry_type label; we need
                        // the raw entry_type so look it up from the DB entries.
                        const dbEntry = entries.find(
                            (e) => (e.label ?? e.entry_type) === record.entryLabel,
                        ) ?? entries.find((e) => e.entry_type === record.entryType);

                        if (!dbEntry) continue;

                        // mem_bytes on the extension record is the closest proxy
                        // for the on-chain entry size we have stored locally.
                        // The raw record doesn't carry mem_bytes directly through
                        // the ExtensionCostDetail shape — query the history rows
                        // that we already have in data.recentExtensions; however
                        // that shape has no mem_bytes field. So we query the DB
                        // entries table for a stored size_bytes (doesn't exist) or
                        // fall back to the DEFAULT. The actual mem_bytes used during
                        // the extension transaction is in extension_history.mem_bytes
                        // but wasn't surfaced. We access it here via the DB directly.
                        if (!sizeByEntryType.has(dbEntry.entry_type)) {
                            const row = db
                                .prepare(
                                    `SELECT mem_bytes FROM extension_history
                                     WHERE contract_entry_id = ? AND mem_bytes IS NOT NULL
                                     ORDER BY executed_at DESC LIMIT 1`,
                                )
                                .get(dbEntry.id) as { mem_bytes: number } | undefined;

                            sizeByEntryType.set(
                                dbEntry.entry_type,
                                row?.mem_bytes ?? DEFAULT_ENTRY_SIZE_BYTES,
                            );
                        }
                    }

                    // Also account for entry types that exist in the DB but might
                    // not have appeared in recentExtensions (e.g. --period filtered
                    // them out).
                    for (const entry of entries) {
                        if (!sizeByEntryType.has(entry.entry_type)) {
                            const row = db
                                .prepare(
                                    `SELECT mem_bytes FROM extension_history
                                     WHERE contract_entry_id = ? AND mem_bytes IS NOT NULL
                                     ORDER BY executed_at DESC LIMIT 1`,
                                )
                                .get(entry.id) as { mem_bytes: number } | undefined;

                            sizeByEntryType.set(
                                entry.entry_type,
                                row?.mem_bytes ?? DEFAULT_ENTRY_SIZE_BYTES,
                            );
                        }
                    }

                    // Only show the section for entry types that actually had
                    // extensions in this period.
                    const activeEntryTypes = Object.keys(data.byEntryType);

                    if (activeEntryTypes.length > 0) {
                        const feePerRent1kb = feeStats
                            ? DEFAULT_FEE_PER_RENT_1KB  // TODO: fetch from network config
                            : DEFAULT_FEE_PER_RENT_1KB;

                        console.log(`\n  ${chalk.bold("Forecasted Rent")} (based on Soroban rent formula)`);

                        if (monthlyBudget !== undefined) {
                            console.log(
                                `  Monthly budget: ${chalk.cyan(monthlyBudget.toFixed(7))} XLM`,
                            );
                        }

                        let anyBreach = false;

                        for (const entryType of activeEntryTypes) {
                            const entrySizeBytes =
                                sizeByEntryType.get(entryType) ?? DEFAULT_ENTRY_SIZE_BYTES;

                            const isPersistent =
                                entryType === "instance" ||
                                entryType === "wasm" ||
                                entryType === "persistent";

                            const isCodeEntry = entryType === "wasm";

                            const forecast = projectRentWindows({
                                entrySizeBytes,
                                feePerRent1kb,
                                isPersistent,
                                isCodeEntry,
                            });

                            const lines = formatForecastedRentEntry(forecast, entryType, monthlyBudget);
                            for (const line of lines) {
                                console.log(line);
                            }

                            // Track whether any window breaches the budget
                            if (
                                monthlyBudget !== undefined &&
                                forecast.windows.some((w) => w.estimatedFeeXlm > monthlyBudget!)
                            ) {
                                anyBreach = true;
                            }
                        }

                        if (anyBreach) {
                            console.log(
                                chalk.bold.red(
                                    `\n  ⚠ One or more forecast windows exceed your monthly budget of ` +
                                    `${monthlyBudget!.toFixed(7)} XLM. ` +
                                    `Consider raising TTLs or reviewing entry sizes to reduce rent costs.`,
                                ),
                            );
                        }
                    }
                }

                console.log(`\n  ${chalk.bold("Recent Extensions")}`);
                const recent = options.all ? data.recentExtensions : data.recentExtensions.slice(0, 10);
                for (const record of recent) {
                    const cost =
                        record.costXlm !== null ? `${record.costXlm.toFixed(7)} XLM` : "N/A";

                    console.log(
                        `    ${chalk.dim(record.executedAt)} ${record.entryLabel}: ${record.oldTtlFormatted} → ${record.newTtlFormatted} (${cost})`,
                    );
                    console.log(`      ${chalk.dim(`tx: ${record.txHash.slice(0, 16)}...`)}`);
                }

                if (!options.all && data.recentExtensions.length > 10) {
                    console.log(
                        chalk.dim(
                            `\n    ... and ${data.recentExtensions.length - 10} more. Use --all to see everything.`,
                        ),
                    );
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Costs command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });
}
