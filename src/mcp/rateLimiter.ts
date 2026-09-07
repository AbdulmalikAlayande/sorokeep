export const DEFAULT_REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60 * 1000;

interface RateLimitState {
    count: number;
    windowStart: number;
}

/**
 * A simple in-memory fixed-window rate limiter, scoped per tool name.
 * Protects the daemon's shared SQLite connection from being hammered by a
 * runaway AI loop or a malicious MCP client (issue #411).
 */
export class ToolRateLimiter {
    private readonly limit: number;
    private readonly states = new Map<string, RateLimitState>();

    constructor(limit: number = DEFAULT_REQUESTS_PER_MINUTE) {
        this.limit = limit;
    }

    /**
     * Record and check one invocation of `toolName`. Returns true (and
     * increments the count) if under the limit; returns false without
     * mutating state if the limit for the current window is already hit.
     */
    tryConsume(toolName: string): boolean {
        const now = Date.now();
        let state = this.states.get(toolName);

        if (!state || now - state.windowStart >= WINDOW_MS) {
            state = { count: 0, windowStart: now };
            this.states.set(toolName, state);
        }

        if (state.count >= this.limit) {
            return false;
        }

        state.count++;
        return true;
    }

    reset(): void {
        this.states.clear();
    }
}
