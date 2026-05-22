import {Logger} from "./types.js";
import {createLogger} from "./logger.js";

export type AppMode = "cli" | "daemon" | "test";

export interface AppLoggingConfig {
    mode: AppMode;
    level?: "debug" | "info" | "warn" | "error" | "fatal";
}

let globalLogger: Logger | null = null;

/**
 * Simple global accessor so we don't pass logger everywhere if we don’t want to.
 * For stricter design, we could DI this instead.
 */
export function initLogger(config: AppLoggingConfig): Logger {
    if (globalLogger) return globalLogger;
    const prettyPrint = config.mode === "cli";
    const level = config.level ?? (config.mode === "test" ? "error" : config.mode === "daemon" ? "info" : "debug");

    globalLogger = createLogger({ level, prettyPrint });
    return globalLogger;
}

export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = createLogger({ level: 'info', prettyPrint: process.stdout.isTTY });
    }
    return globalLogger;
}