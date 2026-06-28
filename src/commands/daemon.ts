import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { startDaemon, stopDaemon } from "../daemon/loop.js";
import { configureLogger, getLogger } from "../logging/index.js";

export function registerDaemonCommand(program: Command): void {
    program
        .command("daemon")
        .description("Start the monitoring daemon — polls contracts at a fixed interval")
        .option("--network <network>", "Stellar network to monitor", "testnet")
        .option("--interval <ms>", "Polling interval in milliseconds", "300000")
        .option("-r, --rpc-url <url>", "Custom RPC endpoint URL")
        .option("--log-format <format>", "Log output format: 'pretty' (human-readable) or 'json' (structured)", "pretty")
        .action(async (options: {
            network: string;
            interval: string;
            rpcUrl?: string;
            logFormat: string;
        }) => {
            const intervalMs = parseInt(options.interval, 10);
            if (isNaN(intervalMs) || intervalMs < 10000) {
                console.log(chalk.red("Error: --interval must be a number >= 10000 (10 seconds)"));
                process.exit(1);
            }

            if (options.logFormat !== "pretty" && options.logFormat !== "json") {
                console.log(chalk.red("Error: --log-format must be either 'pretty' or 'json'"));
                process.exit(1);
            }

            // Reconfigure the global logger for the daemon process so every
            // component (this command and the loop) honours the chosen format.
            configureLogger({ mode: "daemon", format: options.logFormat });
            const logger = getLogger().child({ component: "DaemonCommand" });

            let db;
            try {
                db = getDatabase();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(chalk.red(`Failed to open database: ${msg}`));
                logger.error("Database initialization failed", { error: msg });
                process.exit(1);
            }

            console.log();
            console.log(chalk.bold("  Sorokeep — Daemon"));
            console.log(`  Network:   ${chalk.cyan(options.network)}`);
            console.log(`  Interval:  ${chalk.cyan(Math.floor(intervalMs / 1000) + "s")}`);
            if (options.rpcUrl) {
                console.log(`  RPC:       ${chalk.cyan(options.rpcUrl)}`);
            }
            console.log();
            console.log(chalk.dim("  Press Ctrl+C to stop.\n"));

            // ── Graceful shutdown ────────────────────────────────────
            const shutdown = () => {
                console.log(chalk.yellow("\n  Shutting down daemon..."));
                stopDaemon();
                try {
                    db.close();
                } catch {
                    // DB may already be closed — not an error worth surfacing
                }
                process.exit(0);
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);

            // ── Start the loop ───────────────────────────────────────
            await startDaemon(db, options.network, {
                intervalMs,
                rpcUrl: options.rpcUrl,
                onCycle: (result, error) => {
                    const timestamp = new Date().toLocaleTimeString();

                    if (error) {
                        console.log(
                            chalk.dim(`  [${timestamp}]`) +
                            chalk.red(` Cycle failed: ${error.message}`),
                        );
                        return;
                    }

                    if (result) {
                        const parts = [
                            `Checked ${result.contractsChecked} contract(s)`,
                            `updated ${result.entriesUpdated} entries`,
                            `${result.thresholdsCrossed} threshold(s) crossed`,
                            `${result.alertsResolved} resolved`,
                        ];

                        if (result.errors.length > 0) {
                            parts.push(chalk.red(`${result.errors.length} error(s)`));
                        }

                        console.log(
                            chalk.dim(`  [${timestamp}]`) + ` ${parts.join(", ")}`,
                        );
                    }
                },
            });
        });
}
