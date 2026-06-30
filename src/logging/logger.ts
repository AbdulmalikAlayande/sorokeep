import {Logger, LogLevel} from "./types.js";
import chalk from "chalk";
import pino, { LoggerOptions as PinoLoggerOptions, Logger as PinoLogger, DestinationStream} from "pino"
import util from "util"

export type LogFormat = "pretty" | "json";

export interface LoggerConfig {
    level: LogLevel;
    prettyPrint: boolean;
    logFile?: string;
    /** Output format. "json" emits one structured JSON object per line. */
    format?: LogFormat;
    /** Optional destination stream — used mainly for tests or custom sinks. */
    destination?: DestinationStream;
}

function createLoggerInstance(config: LoggerConfig): PinoLogger {

    const options: PinoLoggerOptions = {
        level: config.level ?? "info",
    }

    if (config.format === "json") {
        // Structured, line-delimited JSON suitable for log aggregators.
        // Emit the level as a human-readable label and an ISO-8601 timestamp
        // under a stable `timestamp` key so downstream tools (jq, Loki, …)
        // can rely on the shape.
        options.timestamp = () => `,"timestamp":"${new Date().toISOString()}"`;
        options.formatters = {
            level: (label) => ({ level: label }),
        };
        return config.destination ? pino(options, config.destination) : pino(options);
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
    private readonly colorize: boolean;

    constructor(loggerInstance: PinoLogger, bindings: Record<string, unknown> = {}, colorize: boolean = true) {
        this.logger = loggerInstance;
        this.bindings = bindings;
        this.colorize = colorize;
    }

    child(bindings: Record<string, unknown>): Logger {
        const child = this.logger.child(bindings);
        return new LoggerWrapper(child, { ...this.bindings, ...bindings }, this.colorize);
    }

    private logWithStyle(level: "debug" | "info" | "warn" | "error" | "fatal", message: string, meta: unknown[]) {
        // In JSON mode keep messages plain — ANSI escapes would pollute the
        // structured `msg` field and break log parsing. Bound fields (e.g.
        // `component`) are already carried by the underlying pino child, so we
        // don't re-emit them here to avoid duplicate keys.
        if (!this.colorize) {
            if (meta && meta.length > 0) {
                this.logger[level]({ meta }, message);
            } else {
                this.logger[level](message);
            }
            return;
        }

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
    const colorize = config.format !== "json" && config.prettyPrint;
    return new LoggerWrapper(loggerInstance, {}, colorize);
}
