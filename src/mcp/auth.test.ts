import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SorokeepConfig } from "../utils/config.js";
import { resolveToken, verifyRequest } from "./auth.js";
import { getLogger } from "../logging/index.js";

describe("MCP Authentication", () => {
    const originalEnv = { ...process.env };
    const mockLogger = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(() => mockLogger),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Mock getLogger to return our mock logger
        vi.spyOn({ getLogger }, "getLogger" as any).mockReturnValue(mockLogger);
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe("resolveToken()", () => {
        it("returns env var SOROKEEP_MCP_TOKEN when set", () => {
            process.env.SOROKEEP_MCP_TOKEN = "token-from-env";
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
                mcpAuthToken: "token-from-config",
            };

            const result = resolveToken(config);
            expect(result).toBe("token-from-env");
        });

        it("returns config.mcpAuthToken when env var not set", () => {
            delete process.env.SOROKEEP_MCP_TOKEN;
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
                mcpAuthToken: "token-from-config",
            };

            const result = resolveToken(config);
            expect(result).toBe("token-from-config");
        });

        it("returns null when neither env var nor config field is set", () => {
            delete process.env.SOROKEEP_MCP_TOKEN;
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
            };

            const result = resolveToken(config);
            expect(result).toBeNull();
        });

        it("prefers env var over config field", () => {
            process.env.SOROKEEP_MCP_TOKEN = "env-token";
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
                mcpAuthToken: "config-token",
            };

            const result = resolveToken(config);
            expect(result).toBe("env-token");
        });

        it("never logs the token value", () => {
            process.env.SOROKEEP_MCP_TOKEN = "secret-token-12345";
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
            };

            resolveToken(config);

            // Check that logger was called
            expect(mockLogger.debug).toHaveBeenCalled();
            // Check that the secret token is NOT in any logger call
            const allCalls = mockLogger.debug.mock.calls.flat();
            const allCallsString = JSON.stringify(allCalls);
            expect(allCallsString).not.toContain("secret-token-12345");
        });
    });

    describe("verifyRequest()", () => {
        it("returns true when no token is configured (open access)", () => {
            const result = verifyRequest("any-token", null);
            expect(result).toBe(true);
        });

        it("returns true when no token configured and client provides none", () => {
            const result = verifyRequest(null, null);
            expect(result).toBe(true);
        });

        it("returns true when correct token is provided", () => {
            const configuredToken = "secret-token";
            const providedToken = "secret-token";
            const result = verifyRequest(providedToken, configuredToken);
            expect(result).toBe(true);
        });

        it("returns false when wrong token is provided", () => {
            const configuredToken = "secret-token";
            const providedToken = "wrong-token";
            const result = verifyRequest(providedToken, configuredToken);
            expect(result).toBe(false);
        });

        it("returns false when token is missing but token is configured", () => {
            const configuredToken = "secret-token";
            const providedToken = null;
            const result = verifyRequest(providedToken, configuredToken);
            expect(result).toBe(false);
        });

        it("returns false when empty string token provided against configured token", () => {
            const configuredToken = "secret-token";
            const providedToken = "";
            const result = verifyRequest(providedToken, configuredToken);
            expect(result).toBe(false);
        });

        it("is case-sensitive for token comparison", () => {
            const configuredToken = "SecretToken";
            const providedToken = "secrettoken";
            const result = verifyRequest(providedToken, configuredToken);
            expect(result).toBe(false);
        });
    });

    describe("Security: token never logged", () => {
        it("does not log token in any form during resolveToken with env var", () => {
            process.env.SOROKEEP_MCP_TOKEN = "SENSITIVE_TOKEN_VALUE_12345";
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
            };

            resolveToken(config);

            // Verify no logger calls contain the token
            expect(mockLogger.debug.mock.calls.join("")).not.toContain(
                "SENSITIVE_TOKEN_VALUE_12345"
            );
            expect(mockLogger.info.mock.calls.join("")).not.toContain(
                "SENSITIVE_TOKEN_VALUE_12345"
            );
            expect(mockLogger.warn.mock.calls.join("")).not.toContain(
                "SENSITIVE_TOKEN_VALUE_12345"
            );
        });

        it("does not log token in any form during resolveToken with config", () => {
            delete process.env.SOROKEEP_MCP_TOKEN;
            const config: SorokeepConfig = {
                network: "testnet",
                pollingIntervalSeconds: 300,
                mcpAuthToken: "CONFIG_SECRET_TOKEN_67890",
            };

            resolveToken(config);

            // Verify no logger calls contain the token
            expect(mockLogger.debug.mock.calls.join("")).not.toContain(
                "CONFIG_SECRET_TOKEN_67890"
            );
        });
    });
});
