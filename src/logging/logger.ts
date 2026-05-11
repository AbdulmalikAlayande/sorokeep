import {Logger, LogLevel} from "./types";
import pino, { LoggerOptions as PinoLoggerOptions, Logger as PinoLogger} from "pino"

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

    debug(message: string, ...meta: unknown[]): void {
        meta ? this.logger.debug(meta, message) : this.logger.debug(message);
    }

    error(message: string, ...meta: unknown[]): void {
        meta ? this.logger.error(meta, message) : this.logger.error(message);
    }

    fatal(message: string, ...meta: unknown[]): void {
        meta ? this.logger.fatal(meta, message) : this.logger.fatal(message);
    }

    info(message: string, ...meta: unknown[]): void {
        meta ? this.logger.info(meta, message) : this.logger.info(message);
    }

    warn(message: string, ...meta: unknown[]): void {
        meta ? this.logger.warn(meta, message) : this.logger.warn(message);
    }
}

export function createLogger(config: LoggerConfig): Logger {
    const loggerInstance = createLoggerInstance(config);
    return new LoggerWrapper(loggerInstance);
}