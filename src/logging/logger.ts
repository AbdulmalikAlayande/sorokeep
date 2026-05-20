import {Logger, LogLevel} from "./types";
import chalk from "chalk";
import pino, { LoggerOptions as PinoLoggerOptions, Logger as PinoLogger} from "pino"
import util from "util"

export interface LoggerConfig {
    level: LogLevel;
    prettyPrint: boolean;
    logFile?: string;
}

function createLoggerInstance(config: LoggerConfig): PinoLogger {

    const options: PinoLoggerOptions = {
        level: config.level ?? "info",
    }

    if (config.prettyPrint && process.stdout.isTTY) {
        options.transport = {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
            }
        }
    }
    else if (config.logFile) {
        options.transport = {
            target: "pino/file",
            options: { destination: config.logFile }
        }
    }
    else {
        options.transport = {
            target: "pino/file",
            options: { destination: "stdout" }
        }
    }

    return pino(options);
}

function formatMetaForLog(meta: unknown[]): string {
    if (!meta || meta.length === 0) return "";
    return meta.map(item => {
        if (item instanceof Error) {
            console.log(item.stack) // Prints stack if available
            return item.stack ?? item.message;
        }
        if (typeof item === "string") return item;
        try {
            return util.inspect(item, { depth: 2, colors: false });
        } catch {
            return String(item);
        }
    }).join(" ");
}

function styleForLevel(level: string, text: string): string {
    switch (level) {
        case "debug":
            return chalk.cyan.dim(text);
        case "info":
            return chalk.green.bold(text);
        case "warn":
            return chalk.yellow.bold(text);
        case "error":
            return chalk.red.bold(text);
        case "fatal":
            return chalk.bgRed.white.bold(text);
        default:
            return text;
    }
}
class LoggerWrapper implements Logger {
    private readonly logger: PinoLogger;
    private readonly bindings: Record<string, unknown>;

    constructor(loggerInstance: PinoLogger, bindings: Record<string, unknown> = {}) {
        this.logger = loggerInstance;
        this.bindings = bindings;
    }

    child(bindings: Record<string, unknown>): Logger {
        const child = this.logger.child(bindings);
        return new LoggerWrapper(child, { ...this.bindings, ...bindings });
    }

    private logWithStyle(level: "debug" | "info" | "warn" | "error" | "fatal", message: string, meta: unknown[]) {
        const metaStr = formatMetaForLog(meta);
        const styledMessage = styleForLevel(level, message);
        const styledMeta = metaStr ? chalk.gray.dim(metaStr) : "";

        if (metaStr) {
            this.logger[level]({ ...this.bindings, meta }, `${styledMessage} ${styledMeta}`);
        } else {
            this.logger[level]({ ...this.bindings }, styledMessage);
        }
    }

    debug(message: string, ...meta: unknown[]): void {
        this.logWithStyle("debug", message, meta);
    }

    error(message: string, ...meta: unknown[]): void {
        this.logWithStyle("error", message, meta);
    }

    fatal(message: string, ...meta: unknown[]): void {
        this.logWithStyle("fatal", message, meta);
    }

    info(message: string, ...meta: unknown[]): void {
        this.logWithStyle("info", message, meta);
    }

    warn(message: string, ...meta: unknown[]): void {
        this.logWithStyle("warn", message, meta);
    }
}

export function createLogger(config: LoggerConfig): Logger {
    const loggerInstance = createLoggerInstance(config);
    return new LoggerWrapper(loggerInstance);
}
