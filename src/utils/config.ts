import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import YAML from "yaml";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "Config" });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VaultConfig {
    /** HashiCorp Vault server URL, e.g. https://vault.example.com */
    url: string;
    /** Vault authentication token */
    token: string;
    /** Optional Vault namespace (for Vault Enterprise) */
    namespace?: string;
}

export interface SorokeepConfig {
    /** Default network to use. */
    network: string;
    /** Default RPC URL override. */
    rpcUrl?: string;
    /** Default polling interval in seconds for the daemon. */
    pollingIntervalSeconds: number;
    /** Slack bot token for Slack alert delivery. */
    slackToken?: string;
    /**
     * Monthly rent budget in XLM. When set, the `costs` command will compare
     * the 30/60/90-day forecasted rent windows against this value and display
     * a warning in red when any window exceeds it.
     */
    monthlyBudgetXlm?: number;

    /** HashiCorp Vault configuration for secret key retrieval */
    vault?: VaultConfig;
    /**
     * Secret key of the fee sponsor account.
     * When set, auto-extension transactions are wrapped in FeeBumpTransactions
     * so this account pays all fees instead of the contract keypair.
     * Supports "env:VAR_NAME" or a direct Stellar secret key starting with "S".
     */
    feeSponsorSecret?: string;

}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SorokeepConfig = {
  network: "testnet",
  pollingIntervalSeconds: 300,
};

const SOROKEEP_DIR = path.join(os.homedir(), ".sorokeep");
const CONFIG_FILE = path.join(SOROKEEP_DIR, "config.yaml");

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load configuration from ~/.sorokeep/config.yaml.
 * Returns defaults if the file does not exist.
 */
export function loadConfig(customPath?: string): SorokeepConfig {
  const configPath = customPath ?? CONFIG_FILE;

  if (!fs.existsSync(configPath)) {
    logger.debug(`No config file found at ${configPath}, using defaults`);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Partial<SorokeepConfig>;

        let vault: VaultConfig | undefined;
        if (parsed.vault && typeof parsed.vault === "object") {
            const v = parsed.vault as Partial<VaultConfig>;
            if (v.url && v.token) {
                vault = {
                    url: v.url,
                    token: v.token,
                    namespace: v.namespace,
                };
            }
        }

        return {
            network: parsed.network ?? DEFAULT_CONFIG.network,
            rpcUrl: parsed.rpcUrl,
            pollingIntervalSeconds: typeof parsed.pollingIntervalSeconds === "number" && parsed.pollingIntervalSeconds > 0
                ? parsed.pollingIntervalSeconds
                : DEFAULT_CONFIG.pollingIntervalSeconds,
            slackToken: parsed.slackToken,
            monthlyBudgetXlm: typeof parsed.monthlyBudgetXlm === "number" && parsed.monthlyBudgetXlm > 0
                ? parsed.monthlyBudgetXlm
                : undefined,

            vault,
            feeSponsorSecret: typeof parsed.feeSponsorSecret === "string" ? parsed.feeSponsorSecret : undefined,

        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to parse config at ${configPath}: ${message}. Using defaults.`);
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * Save configuration to ~/.sorokeep/config.yaml.
 */
export function saveConfig(config: SorokeepConfig, customPath?: string): void {
  const configPath = customPath ?? CONFIG_FILE;
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const yamlStr = YAML.stringify(config);
  fs.writeFileSync(configPath, yamlStr, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // best effort for existing files
  }
  logger.debug(`Config saved to ${configPath}`);
}

/**
 * Get the Sorokeep data directory path.
 */
export function getSorokeepDir(): string {
  return SOROKEEP_DIR;
}

