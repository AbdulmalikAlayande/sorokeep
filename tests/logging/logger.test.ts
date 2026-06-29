import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../../src/logging/logger";

/**
 * Build a JSON-format logger that writes to an in-memory stream so the
 * structured output can be inspected line-by-line.
 */
function captureJsonLogger() {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            for (const line of chunk.toString().split("\n")) {
                if (line.trim()) lines.push(line);
            }
            cb();
        },
    });
    const logger = createLogger({
        level: "debug",
        prettyPrint: false,
        format: "json",
        destination: stream,
    });
    return { logger, lines };
}

describe("JSON log format", () => {
    it("emits one structured JSON line per log call", () => {
        const { logger, lines } = captureJsonLogger();

        logger.info("daemon online");

        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0]);
        expect(parsed.msg).toBe("daemon online");
    });

    it("includes component, level, and timestamp fields", () => {
        const { logger, lines } = captureJsonLogger();

        logger.child({ component: "DaemonCommand" }).warn("ttl low");

        const parsed = JSON.parse(lines.at(-1)!);
        expect(parsed.component).toBe("DaemonCommand");
        expect(parsed.level).toBe("warn");
        expect(typeof parsed.timestamp).toBe("string");
        // timestamp must be a valid, parseable date
        expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);
    });

    it("does not embed ANSI colour codes in the JSON output", () => {
        const { logger, lines } = captureJsonLogger();

        logger.error("cycle failed");

        const parsed = JSON.parse(lines.at(-1)!);
        expect(parsed.msg).toBe("cycle failed");
        // eslint-disable-next-line no-control-regex
        expect(lines.at(-1)!).not.toMatch(/\[/);
    });

    it("produces valid JSON that can be parsed", () => {
        const { logger, lines } = captureJsonLogger();

        logger.child({ component: "DaemonLoop" }).info("checked 3 contracts");
        logger.info("done");

        const messages = lines.map(line => JSON.parse(line).msg);

        expect(messages).toContain("checked 3 contracts");
        expect(messages).toContain("done");
    });
});
