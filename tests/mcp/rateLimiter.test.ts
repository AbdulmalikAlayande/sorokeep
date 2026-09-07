import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ToolRateLimiter, DEFAULT_REQUESTS_PER_MINUTE } from "../../src/mcp/rateLimiter.js";

describe("ToolRateLimiter", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("allows calls up to the configured limit", () => {
        const limiter = new ToolRateLimiter(3);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(true);
    });

    it("rejects calls once the limit is exceeded within the window", () => {
        const limiter = new ToolRateLimiter(2);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(false);
        expect(limiter.tryConsume("tool_a")).toBe(false);
    });

    it("tracks each tool name independently", () => {
        const limiter = new ToolRateLimiter(1);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_b")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(false);
        expect(limiter.tryConsume("tool_b")).toBe(false);
    });

    it("resets the count once the 60-second window elapses", () => {
        const limiter = new ToolRateLimiter(1);
        expect(limiter.tryConsume("tool_a")).toBe(true);
        expect(limiter.tryConsume("tool_a")).toBe(false);

        vi.advanceTimersByTime(60_001);

        expect(limiter.tryConsume("tool_a")).toBe(true);
    });

    it("defaults to DEFAULT_REQUESTS_PER_MINUTE when no limit is given", () => {
        const limiter = new ToolRateLimiter();
        for (let i = 0; i < DEFAULT_REQUESTS_PER_MINUTE; i++) {
            expect(limiter.tryConsume("tool_a")).toBe(true);
        }
        expect(limiter.tryConsume("tool_a")).toBe(false);
    });

    it("reset() clears all tracked state", () => {
        const limiter = new ToolRateLimiter(1);
        limiter.tryConsume("tool_a");
        expect(limiter.tryConsume("tool_a")).toBe(false);

        limiter.reset();

        expect(limiter.tryConsume("tool_a")).toBe(true);
    });
});
