import { describe, it, expect, vi, beforeEach } from "vitest";
import { AWSSecretsResolver } from "../../src/core/aws_secrets.js";

// Mock the dynamic import of @aws-sdk/client-secrets-manager
vi.mock("@aws-sdk/client-secrets-manager", async () => {
    const SecretsManagerClient = vi.fn().mockImplementation(() => {
        return {
            send: vi.fn().mockImplementation(async (command) => {
                if (command.input.SecretId === "my-stellar-key") {
                    return { SecretString: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" };
                }
                if (command.input.SecretId === "missing-string-key") {
                    return {}; // Missing SecretString
                }
                throw new Error("Secret not found");
            }),
        };
    });
    
    const GetSecretValueCommand = vi.fn().mockImplementation((args) => {
        return { input: args };
    });

    return {
        SecretsManagerClient,
        GetSecretValueCommand,
    };
});

// Mock @aws-sdk/credential-providers for standard IAM profile credentials
vi.mock("@aws-sdk/credential-providers", async () => {
    return {
        fromIni: vi.fn().mockImplementation((config) => {
            return async () => ({
                accessKeyId: "mock-access-key",
                secretAccessKey: "mock-secret-key",
            });
        }),
    };
});

describe("AWSSecretsResolver", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves keys correctly from AWS Secrets Manager when credentials match", async () => {
        const resolver = new AWSSecretsResolver({ region: "us-east-1", profile: "default" });
        const secretValue = await resolver.resolveKey("my-stellar-key");
        
        expect(secretValue).toBe("SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    });
    
    it("throws an error if secret is not found", async () => {
        const resolver = new AWSSecretsResolver({ region: "us-east-1" });
        await expect(resolver.resolveKey("unknown-key")).rejects.toThrow("Secret not found");
    });

    it("throws an error if SecretString is empty", async () => {
        const resolver = new AWSSecretsResolver({ region: "us-east-1" });
        await expect(resolver.resolveKey("missing-string-key")).rejects.toThrow("SecretString is empty for secret: missing-string-key");
    });
});
