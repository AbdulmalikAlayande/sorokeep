import { describe, it, expect } from "vitest";
import { enforceMcpRateLimit } from "../../src/mcp/server.js";
import { ToolRateLimiter } from "../../src/mcp/rateLimiter.js";

/**
 * A minimal fake server exposing only `.tool()`, shaped like McpServer's
 * public surface — mirrors the pattern used for enforceMcpAuth's own tests.
 */
function makeFakeServer() {
    const registered: Record<string, (...args: unknown[]) => unknown> = {};
    return {
        tool(...args: unknown[]): void {
            const name = args[0] as string;
            const cb = args[args.length - 1] as (...cbArgs: unknown[]) => unknown;
            registered[name] = cb;
        },
        invoke(name: string, ...cbArgs: unknown[]): unknown {
            return registered[name](...cbArgs);
        },
    };
}

describe("enforceMcpRateLimit", () => {
    it("allows calls under the limit through unchanged", async () => {
        const server = enforceMcpRateLimit(makeFakeServer(), new ToolRateLimiter(3));
        server.tool("some_tool", async () => "ok");

        expect(await server.invoke("some_tool")).toBe("ok");
        expect(await server.invoke("some_tool")).toBe("ok");
    });

    it("rejects a real call once the tool's limit is exceeded", async () => {
        const server = enforceMcpRateLimit(makeFakeServer(), new ToolRateLimiter(1));
        server.tool("some_tool", async () => "ok");

        await server.invoke("some_tool");
        await expect(server.invoke("some_tool")).rejects.toThrow(/Rate limit exceeded/);
    });

    it("enforces each tool independently", async () => {
        const limiter = new ToolRateLimiter(1);
        const server = enforceMcpRateLimit(makeFakeServer(), limiter);
        server.tool("tool_a", async () => "a");
        server.tool("tool_b", async () => "b");

        expect(await server.invoke("tool_a")).toBe("a");
        expect(await server.invoke("tool_b")).toBe("b");
        await expect(server.invoke("tool_a")).rejects.toThrow(/Rate limit exceeded/);
    });

    it("does not affect the return value of the wrapped callback", async () => {
        const server = enforceMcpRateLimit(makeFakeServer(), new ToolRateLimiter(5));
        server.tool("echo_tool", async (args: unknown) => ({ echoed: args }));

        expect(await server.invoke("echo_tool", { foo: "bar" })).toEqual({ echoed: { foo: "bar" } });
    });
});
