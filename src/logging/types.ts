export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
    debug(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
    fatal(message: string, ...meta: unknown[]): void;

    // child logger with extra bound fields
    // to be used mainly for per-contract or per-job loggers.
    child(bindings: Record<string, unknown>): Logger;
}