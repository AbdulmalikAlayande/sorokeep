import { describe, it, expect } from "vitest";
import { resolveToken, verifyRequest, extractBearerToken } from "../../src/mcp/auth.js";
import type { SorokeepConfig } from "../../src/utils/config.js";

function makeConfig(overrides: Partial<SorokeepConfig> = {}): SorokeepConfig {
    return {
        network: "testnet",
        pollingIntervalSeconds: 300,
        ...overrides,
    };
}

describe("resolveToken", () => {
    it("prefers SOROKEEP_MCP_TOKEN over config.mcpAuthToken", () => {
        process.env.SOROKEEP_MCP_TOKEN = "env-token";
        const token = resolveToken(makeConfig({ mcpAuthToken: "config-token" }));
        expect(token).toBe("env-token");
        delete process.env.SOROKEEP_MCP_TOKEN;
    });

    it("falls back to config.mcpAuthToken when env var is unset", () => {
        delete process.env.SOROKEEP_MCP_TOKEN;
        const token = resolveToken(makeConfig({ mcpAuthToken: "config-token" }));
        expect(token).toBe("config-token");
    });

    it("returns null when neither is set", () => {
        delete process.env.SOROKEEP_MCP_TOKEN;
        const token = resolveToken(makeConfig());
        expect(token).toBeNull();
    });
});

describe("verifyRequest", () => {
    it("grants access when no token is configured", () => {
        expect(verifyRequest(undefined, null)).toBe(true);
        expect(verifyRequest("anything", null)).toBe(true);
    });

    it("denies access when a token is configured but none is provided", () => {
        expect(verifyRequest(undefined, "secret")).toBe(false);
        expect(verifyRequest(null, "secret")).toBe(false);
        expect(verifyRequest("", "secret")).toBe(false);
    });

    it("denies access on mismatch", () => {
        expect(verifyRequest("wrong", "secret")).toBe(false);
    });

    it("grants access on exact match", () => {
        expect(verifyRequest("secret", "secret")).toBe(true);
    });

    it("is case-sensitive", () => {
        expect(verifyRequest("Secret", "secret")).toBe(false);
    });
});

describe("extractBearerToken", () => {
    it("returns null when requestInfo is missing", () => {
        expect(extractBearerToken(undefined)).toBeNull();
        expect(extractBearerToken(null)).toBeNull();
    });

    it("returns null when there is no authorization header", () => {
        expect(extractBearerToken({ headers: {} })).toBeNull();
    });

    it("extracts a bearer token from a plain headers object", () => {
        expect(extractBearerToken({ headers: { authorization: "Bearer abc123" } })).toBe("abc123");
    });

    it("extracts a bearer token from a Headers instance", () => {
        const headers = new Headers();
        headers.set("authorization", "Bearer abc123");
        expect(extractBearerToken({ headers })).toBe("abc123");
    });

    it("is case-insensitive on the 'Bearer' scheme", () => {
        expect(extractBearerToken({ headers: { authorization: "bearer abc123" } })).toBe("abc123");
    });

    it("returns null for a non-Bearer scheme", () => {
        expect(extractBearerToken({ headers: { authorization: "Basic abc123" } })).toBeNull();
    });
});
