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

/**
 * Permission posture of the MCP server.
 *
 * - `read-only`  — only tools tagged as read-only may be invoked. Safe to expose
 *                  to an untrusted agent.
 * - `read-write` — every registered tool may be invoked, including tools that
 *                  change state. For trusted internal tooling only.
 */
export type McpMode = "read-only" | "read-write";

export const MCP_MODES: readonly McpMode[] = ["read-only", "read-write"];

/** The posture used when nothing is configured: the restrictive one. */
export const DEFAULT_MCP_MODE: McpMode = "read-only";

export interface McpConfig {
    /** Permission mode the MCP server runs in. Defaults to `read-only`. */
    mode: McpMode;
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
    /** Telegram bot token. */
    telegramBotToken?: string;
    /** Directory containing custom Handlebars templates. */
    templatesPath?: string;
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

    /**
     * MCP server settings. Omitting this section leaves the server in
     * `read-only` mode, which is the intended default for untrusted agents.
     */
    mcp?: McpConfig;

    /** SMTP configuration for email alert delivery. */
    smtp?: {
        host: string;
        port: number;
        user: string;
        pass: string;
    };

    /**
     * Authentication token for the MCP server. When set, HTTP-transport tool
     * calls must present it as a Bearer token. Prefer SOROKEEP_MCP_TOKEN over
     * this field so the token itself is never written to disk in plaintext.
     */
    mcpAuthToken?: string;

    /**
     * CIDR-aware IP allowlist for sorokeep's HTTP-exposing features (the
     * Prometheus /metrics and /readyz endpoints). Entries may be bare IPs
     * (treated as /32 or /128) or CIDR ranges (e.g. "10.0.0.0/8"). Unset
     * preserves today's open behavior — defense in depth for deployments
     * where the daemon might be bound beyond localhost.
     */
    allowedIps?: string[];

    /**
     * Maximum MCP tool invocations allowed per tool name per 60-second
     * window. Protects the daemon's shared SQLite connection from being
     * hammered by a runaway AI loop or a malicious client. Defaults to 60.
     */
    requestsPerMinute?: number;

}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SorokeepConfig = {
  network: "testnet",
  pollingIntervalSeconds: 300,
  mcp: { mode: DEFAULT_MCP_MODE },
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
            telegramBotToken: parsed.telegramBotToken,
            templatesPath: parsed.templatesPath,
            monthlyBudgetXlm: typeof parsed.monthlyBudgetXlm === "number" && parsed.monthlyBudgetXlm > 0
                ? parsed.monthlyBudgetXlm
                : undefined,

            vault,
            mcp: parseMcpConfig(parsed.mcp),
            feeSponsorSecret: typeof parsed.feeSponsorSecret === "string" ? parsed.feeSponsorSecret : undefined,
            smtp: parseSmtpConfig(parsed.smtp),
            mcpAuthToken: typeof parsed.mcpAuthToken === "string" ? parsed.mcpAuthToken : undefined,
            allowedIps: Array.isArray(parsed.allowedIps) && parsed.allowedIps.every((ip) => typeof ip === "string")
                ? parsed.allowedIps
                : undefined,
            requestsPerMinute: typeof parsed.requestsPerMinute === "number" && parsed.requestsPerMinute > 0
                ? parsed.requestsPerMinute
                : undefined,

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
 * Resolve the MCP permission mode for a config, falling back to the default
 * when the section is absent — callers never have to repeat the default.
 */
export function getMcpMode(config: SorokeepConfig): McpMode {
  return config.mcp?.mode ?? DEFAULT_MCP_MODE;
}

/**
 * Get the Sorokeep data directory path.
 */
export function getSorokeepDir(): string {
  return SOROKEEP_DIR;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function parseMcpConfig(raw: unknown): McpConfig {
    if (!raw || typeof raw !== "object") return { mode: DEFAULT_MCP_MODE };

    const mode = (raw as Record<string, unknown>).mode;
    if (mode === undefined) return { mode: DEFAULT_MCP_MODE };

    if (typeof mode !== "string" || !MCP_MODES.includes(mode as McpMode)) {
        logger.warn(
            `Unrecognised mcp.mode "${String(mode)}". Expected one of ${MCP_MODES.join(", ")}. Falling back to ${DEFAULT_MCP_MODE}.`,
        );
        return { mode: DEFAULT_MCP_MODE };
    }

    return { mode: mode as McpMode };
}

function parseSmtpConfig(raw: unknown): SorokeepConfig["smtp"] {
    if (!raw || typeof raw !== "object") return undefined;
    const s = raw as Record<string, unknown>;
    const port = typeof s.port === "number" ? s.port : typeof s.port === "string" ? Number(s.port) : NaN;
    if (
        typeof s.host === "string" && s.host.length > 0 &&
        !isNaN(port) && port > 0 &&
        typeof s.user === "string" && s.user.length > 0 &&
        typeof s.pass === "string" && s.pass.length > 0
    ) {
        return { host: s.host, port, user: s.user, pass: s.pass };
    }
    return undefined;
}

