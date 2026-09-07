import { describe, it, expect } from "vitest";
import { enforceMcpAuth } from "../../src/mcp/server.js";

/**
 * A minimal fake server exposing only `.tool()`, shaped like McpServer's
 * public surface — enough to exercise enforceMcpAuth without pulling in the
 * real MCP SDK/transport machinery. Mirrors the pattern used for
 * instrumentMcpToolInvocations's own unit tests.
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

describe("enforceMcpAuth", () => {
    it("passes calls through unchanged when no token is configured", async () => {
        const server = enforceMcpAuth(makeFakeServer(), null);
        server.tool("some_tool", async () => "ok");

        const result = await server.invoke("some_tool", {});
        expect(result).toBe("ok");
    });

    it("passes calls through when no requestInfo is present (stdio transport)", async () => {
        const server = enforceMcpAuth(makeFakeServer(), "secret-token");
        server.tool("some_tool", async () => "ok");

        // No `extra.requestInfo` — the shape a stdio-transport call receives.
        const result = await server.invoke("some_tool", {}, {});
        expect(result).toBe("ok");
    });

    it("rejects an HTTP-transport call with no Authorization header when a token is configured", async () => {
        const server = enforceMcpAuth(makeFakeServer(), "secret-token");
        server.tool("some_tool", async () => "ok");

        await expect(
            server.invoke("some_tool", {}, { requestInfo: { headers: {} } }),
        ).rejects.toThrow(/Unauthorized/);
    });

    it("rejects an HTTP-transport call with the wrong token", async () => {
        const server = enforceMcpAuth(makeFakeServer(), "secret-token");
        server.tool("some_tool", async () => "ok");

        await expect(
            server.invoke("some_tool", {}, { requestInfo: { headers: { authorization: "Bearer wrong" } } }),
        ).rejects.toThrow(/Unauthorized/);
    });

    it("allows an HTTP-transport call with the correct bearer token", async () => {
        const server = enforceMcpAuth(makeFakeServer(), "secret-token");
        server.tool("some_tool", async () => "ok");

        const result = await server.invoke(
            "some_tool",
            {},
            { requestInfo: { headers: { authorization: "Bearer secret-token" } } },
        );
        expect(result).toBe("ok");
    });

    it("does not affect the return value or arguments of the wrapped callback", async () => {
        const server = enforceMcpAuth(makeFakeServer(), "secret-token");
        server.tool("echo_tool", async (args: unknown) => ({ echoed: args }));

        const result = await server.invoke(
            "echo_tool",
            { foo: "bar" },
            { requestInfo: { headers: { authorization: "Bearer secret-token" } } },
        );
        expect(result).toEqual({ echoed: { foo: "bar" } });
    });
});
