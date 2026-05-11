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

    constructor(loggerInstance: PinoLogger, bindings?: Record<string, unknown>) {
        this.logger = loggerInstance;
        this.bindings = bindings;
    }

    child(bindings: Record<string, unknown>): Logger {
        const child = this.pino.child(bindings);
        return new LoggerWrapper(child, { ...this.bindings, ...bindings });
    }

    debug(message: string, ...meta: unknown[]): void {
        meta ? this.pino.debug(meta, msg) : this.pino.debug(msg);
    }

    error(message: string, ...meta: unknown[]): void {
        meta ? this.pino.error(meta, msg) : this.pino.error(msg);
    }

    fatal(message: string, ...meta: unknown[]): void {
        meta ? this.pino.fatal(meta, msg) : this.pino.fatal(msg);
    }

    info(message: string, ...meta: unknown[]): void {
        meta ? this.pino.info(meta, msg) : this.pino.info(msg);
    }

    warn(message: string, ...meta: unknown[]): void {
        meta ? this.pino.warn(meta, msg) : this.pino.warn(msg);
    }
}

export function createLogger(config: LoggerConfig): Logger {
    const loggerInstance = createLoggerInstance(config);
    return new LoggerWrapper(loggerInstance);
}