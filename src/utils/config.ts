import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import YAML from "yaml";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "Config" });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SentinelConfig {
    /** Default network to use. */
    network: string;
    /** Default RPC URL override. */
    rpcUrl?: string;
    /** Default polling interval in seconds for the daemon. */
    pollingIntervalSeconds: number;
    /** Slack bot token for Slack alert delivery. */
    slackToken?: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SentinelConfig = {
    network: "testnet",
    pollingIntervalSeconds: 300,
};

const SENTINEL_DIR = path.join(os.homedir(), ".soroban-sentinel");
const CONFIG_FILE = path.join(SENTINEL_DIR, "config.yaml");

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load configuration from ~/.soroban-sentinel/config.yaml.
 * Returns defaults if the file does not exist.
 */
export function loadConfig(customPath?: string): SentinelConfig {
    const configPath = customPath ?? CONFIG_FILE;

    if (!fs.existsSync(configPath)) {
        logger.debug(`No config file found at ${configPath}, using defaults`);
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = YAML.parse(raw) as Partial<SentinelConfig>;

        return {
            network: parsed.network ?? DEFAULT_CONFIG.network,
            rpcUrl: parsed.rpcUrl,
            pollingIntervalSeconds: typeof parsed.pollingIntervalSeconds === "number" && parsed.pollingIntervalSeconds > 0
                ? parsed.pollingIntervalSeconds
                : DEFAULT_CONFIG.pollingIntervalSeconds,
            slackToken: parsed.slackToken,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to parse config at ${configPath}: ${message}. Using defaults.`);
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * Save configuration to ~/.soroban-sentinel/config.yaml.
 */
export function saveConfig(config: SentinelConfig, customPath?: string): void {
    const configPath = customPath ?? CONFIG_FILE;
    const dir = path.dirname(configPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const yamlStr = YAML.stringify(config);
    fs.writeFileSync(configPath, yamlStr, { encoding: "utf-8", mode: 0o600 });
    logger.debug(`Config saved to ${configPath}`);
}

/**
 * Get the Sentinel data directory path.
 */
export function getSentinelDir(): string {
    return SENTINEL_DIR;
}
