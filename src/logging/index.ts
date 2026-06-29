import {Logger} from "./types.js";
import {createLogger, LogFormat} from "./logger.js";

export type AppMode = "cli" | "daemon" | "test";

export interface AppLoggingConfig {
    mode: AppMode;
    level?: "debug" | "info" | "warn" | "error" | "fatal";
    /** Override the output format. Defaults to "pretty" for cli, "json" otherwise. */
    format?: LogFormat;
}

let globalLogger: Logger | null = null;

function buildLogger(config: AppLoggingConfig): Logger {
    const level = config.level ?? (config.mode === "test" ? "error" : config.mode === "daemon" ? "info" : "debug");
    const format: LogFormat = config.format ?? (config.mode === "cli" ? "pretty" : "json");
    const prettyPrint = format === "pretty";

    return createLogger({ level, prettyPrint, format });
}

/**
 * Simple global accessor so we don't pass logger everywhere if we don’t want to.
 * For stricter design, we could DI this instead.
 */
export function initLogger(config: AppLoggingConfig): Logger {
    if (globalLogger) return globalLogger;
    globalLogger = buildLogger(config);
    return globalLogger;
}

/**
 * Force-rebuild the global logger, replacing any previously configured one.
 * Used by long-running entry points (e.g. the daemon) that need to switch
 * the output format at runtime — for example `--log-format json`.
 */
export function configureLogger(config: AppLoggingConfig): Logger {
    globalLogger = buildLogger(config);
    return globalLogger;
}

export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = createLogger({ level: 'info', prettyPrint: process.stdout.isTTY });
    }
    return globalLogger;
}
