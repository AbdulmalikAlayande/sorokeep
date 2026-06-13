import { Command } from "commander";
import chalk from "chalk";
import readline from "node:readline";
import { loadConfig, saveConfig } from "../utils/config.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "ConfigCommand" });

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const TIMEOUT_MS = 10_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Prompt for sensitive input with masked echo (shows * for each character).
 * Uses raw mode on stdin for character-by-character control.
 */
function promptMasked(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        // Disable default echo by switching to raw mode
        if (!process.stdin.isTTY) {
            // Non-interactive: just read a line normally (for piped input)
            rl.question(prompt, (answer) => {
                rl.close();
                resolve(answer.trim());
            });
            return;
        }

        process.stdout.write(prompt);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf-8");

        let input = "";

        const onData = (char: string) => {
            const code = char.charCodeAt(0);

            if (char === "\r" || char === "\n" || code === 10 || code === 13) {
                // Enter pressed
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener("data", onData);
                rl.close();
                process.stdout.write("\n");
                resolve(input);
            } else if (code === 3) {
                // Ctrl+C
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener("data", onData);
                rl.close();
                process.stdout.write("\n");
                reject(new Error("Cancelled"));
            } else if (code === 127 || code === 8) {
                // Backspace
                if (input.length > 0) {
                    input = input.slice(0, -1);
                    process.stdout.write("\b \b");
                }
            } else if (code >= 32) {
                // Printable character
                input += char;
                process.stdout.write("*");
            }
        };

        process.stdin.on("data", onData);
    });
}

/**
 * Prompt with visible input and default value.
 */
function promptVisible(prompt: string, defaultValue?: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const display = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
        rl.question(display, (answer) => {
            rl.close();
            resolve(answer.trim() || defaultValue || "");
        });
    });
}

/**
 * Validate a Slack bot token by calling auth.test.
 * Returns workspace info on success, throws on failure.
 */
async function validateSlackToken(token: string): Promise<{ team: string; user: string; botId: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(SLACK_AUTH_TEST_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({}),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Slack API returned HTTP ${response.status}`);
    }

    const body = await response.json() as {
        ok: boolean;
        error?: string;
        team?: string;
        user?: string;
        bot_id?: string;
    };

    if (!body.ok) {
        throw new Error(`Slack API error: ${body.error ?? "unknown"}`);
    }

    return {
        team: body.team ?? "unknown",
        user: body.user ?? "unknown",
        botId: body.bot_id ?? "unknown",
    };
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
    const config = program
        .command("config")
        .description("View and update Sentinel configuration");

    // ── config show ────────────────────────────────────────────────────
    config
        .command("show")
        .description("Display current configuration")
        .action(() => {
            const cfg = loadConfig();
            console.log(`\n${chalk.bold("  Sentinel Configuration")}\n`);
            console.log(`  Network:            ${chalk.cyan(cfg.network)}`);
            console.log(`  Polling interval:   ${chalk.cyan(cfg.pollingIntervalSeconds + "s")}`);
            console.log(`  RPC URL:            ${cfg.rpcUrl ? chalk.cyan(cfg.rpcUrl) : chalk.dim("(default)")}`);
            console.log(`  Slack token:        ${cfg.slackToken ? chalk.green("configured") : chalk.yellow("not set")}`);
            console.log();
        });

    // ── config set ─────────────────────────────────────────────────────
    config
        .command("set")
        .description("Set a configuration value interactively")
        .argument("<key>", "Configuration key (network, rpcUrl, pollingIntervalSeconds, slackToken)")
        .argument("[value]", "Value to set (omit for interactive/masked input)")
        .action(async (key: string, value: string | undefined) => {
            const cfg = loadConfig();

            try {
                switch (key) {
                    case "network": {
                        const val = value ?? await promptVisible("Network", cfg.network);
                        if (!val) {
                            console.error(chalk.red("Network cannot be empty."));
                            process.exit(1);
                        }
                        cfg.network = val;
                        saveConfig(cfg);
                        console.log(chalk.green(`Network set to ${val}`));
                        break;
                    }

                    case "rpcUrl": {
                        const val = value ?? await promptVisible("RPC URL", cfg.rpcUrl ?? "");
                        cfg.rpcUrl = val || undefined;
                        saveConfig(cfg);
                        console.log(chalk.green(val ? `RPC URL set to ${val}` : "RPC URL cleared (using default)"));
                        break;
                    }

                    case "pollingIntervalSeconds": {
                        const raw = value ?? await promptVisible("Polling interval (seconds)", String(cfg.pollingIntervalSeconds));
                        const num = parseInt(raw, 10);
                        if (isNaN(num) || num <= 0) {
                            console.error(chalk.red("Polling interval must be a positive number."));
                            process.exit(1);
                        }
                        cfg.pollingIntervalSeconds = num;
                        saveConfig(cfg);
                        console.log(chalk.green(`Polling interval set to ${num}s`));
                        break;
                    }

                    case "slackToken": {
                        await handleSlackTokenSetup(cfg, value);
                        break;
                    }

                    default:
                        console.error(chalk.red(`Unknown config key: ${key}`));
                        console.error(chalk.dim("Valid keys: network, rpcUrl, pollingIntervalSeconds, slackToken"));
                        process.exit(1);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.message === "Cancelled") {
                    console.log(chalk.yellow("Cancelled."));
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                logger.error("Config set failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    // ── config remove ──────────────────────────────────────────────────
    config
        .command("remove")
        .description("Remove an optional configuration value")
        .argument("<key>", "Configuration key to remove (rpcUrl, slackToken)")
        .action((key: string) => {
            const cfg = loadConfig();

            switch (key) {
                case "slackToken":
                    cfg.slackToken = undefined;
                    saveConfig(cfg);
                    console.log(chalk.green("Slack token removed from configuration."));
                    break;

                case "rpcUrl":
                    cfg.rpcUrl = undefined;
                    saveConfig(cfg);
                    console.log(chalk.green("RPC URL removed (will use default)."));
                    break;

                default:
                    console.error(chalk.red(`Cannot remove required key: ${key}`));
                    console.error(chalk.dim("Removable keys: rpcUrl, slackToken"));
                    process.exit(1);
            }
        });
}

// ─── Slack Token Flow ────────────────────────────────────────────────────────

async function handleSlackTokenSetup(cfg: ReturnType<typeof loadConfig>, directValue?: string): Promise<void> {
    console.log(`\n${chalk.bold("  Slack Bot Token Setup")}\n`);

    if (cfg.slackToken) {
        console.log(chalk.dim("  A Slack token is already configured."));
        console.log(chalk.dim("  This will replace it.\n"));
    }

    console.log(chalk.dim("  To get a Slack Bot Token:"));
    console.log(chalk.dim("  1. Go to https://api.slack.com/apps"));
    console.log(chalk.dim("  2. Create or select your app"));
    console.log(chalk.dim("  3. Navigate to OAuth & Permissions"));
    console.log(chalk.dim("  4. Add the 'chat:write' bot scope"));
    console.log(chalk.dim("  5. Install to workspace and copy the Bot Token (xoxb-...)\n"));

    let token: string;

    if (directValue) {
        token = directValue;
    } else {
        token = await promptMasked("  Paste your Slack Bot Token: ");
    }

    if (!token) {
        console.error(chalk.red("  Token cannot be empty."));
        process.exit(1);
    }

    if (!token.startsWith("xoxb-")) {
        console.error(chalk.red("  Invalid token format — Slack Bot Tokens start with 'xoxb-'."));
        process.exit(1);
    }

    // Validate by calling auth.test
    console.log(chalk.dim("\n  Validating token..."));

    const info = await validateSlackToken(token);

    cfg.slackToken = token;
    saveConfig(cfg);

    console.log(chalk.green("\n  Slack token configured successfully.\n"));
    console.log(`  Workspace:  ${chalk.cyan(info.team)}`);
    console.log(`  Bot user:   ${chalk.cyan(info.user)}`);
    console.log(`  Bot ID:     ${chalk.cyan(info.botId)}`);
    console.log(chalk.dim(`\n  Token saved to ~/.soroban-sentinel/config.yaml (permissions: 0600)`));
    console.log(chalk.dim(`  You can also set SENTINEL_SLACK_TOKEN env var to override.\n`));
}
