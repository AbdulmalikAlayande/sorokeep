/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We will import after mocking
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const makeStellarSecret = (suffix: string): string => `S${suffix.padEnd(55, "0")}`;

const VALID_STELLAR_SECRET = makeStellarSecret("0");
const VALID_STELLAR_SECRET_2 = makeStellarSecret("1");
const VALID_STELLAR_SECRET_3 = makeStellarSecret("2");
const VALID_STELLAR_SECRET_4 = makeStellarSecret("3");
const VALID_STELLAR_SECRET_5 = makeStellarSecret("4");
const TEST_VAULT_TOKEN = "test-vault-token";

describe("VaultResolver", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches valid secret keys from Vault endpoint (KV v2)", async () => {
        const { VaultResolver, VaultAuthError } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: {
                    data: {
                        secret_key: VALID_STELLAR_SECRET
                    },
                    metadata: { version: 1 }
                }
            })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: TEST_VAULT_TOKEN
        });

        const secret = await resolver.getSecret("secret/data/stellar/mykey");

        expect(secret).toBe(VALID_STELLAR_SECRET);
        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("https://vault.example.com/v1/secret/data/stellar/mykey");
        expect((init as any).headers["X-Vault-Token"]).toBe(TEST_VAULT_TOKEN);
    });

    it("fetches valid secret keys from Vault endpoint (KV v1)", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: {
                    private_key: VALID_STELLAR_SECRET_2
                }
            })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "test-vault-token"
        });

        const secret = await resolver.getSecret("secret/stellar/mykey");
        expect(secret).toBe(VALID_STELLAR_SECRET_2);
    });

    it("raises error on invalid authentication credentials", async () => {
        const { VaultResolver, VaultAuthError } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ errors: ["permission denied"] })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "bad-token"
        });

        await expect(resolver.getSecret("secret/data/stellar/mykey"))
            .rejects.toThrow(VaultAuthError);

        try {
            await resolver.getSecret("secret/data/stellar/mykey");
        } catch (e: any) {
            expect(e.message).toMatch(/authentication|permission|403/i);
        }
    });

    it("raises error when secret is not found", async () => {
        const { VaultResolver, VaultSecretNotFoundError } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: false,
            status: 404,
            json: async () => ({ errors: [] })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: TEST_VAULT_TOKEN
        });

        await expect(resolver.getSecret("secret/data/missing"))
            .rejects.toThrow(VaultSecretNotFoundError);
    });

    it("extracts secret from multiple common field names", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        const testCases = [
            { field: "secret", value: VALID_STELLAR_SECRET },
            { field: "value", value: VALID_STELLAR_SECRET_3 },
            { field: "stellar_secret", value: VALID_STELLAR_SECRET_4 },
        ];

        for (const tc of testCases) {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: { data: { [tc.field]: tc.value } } })
            } as any);

            const resolver = new VaultResolver({ url: "https://vault.example.com", token: "t" });
            const secret = await resolver.getSecret("secret/data/x");
            expect(secret).toBe(tc.value);
        }
    });

    it("supports field selection via #fragment", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: { data: { my_custom_field: VALID_STELLAR_SECRET_4 } }
            })
        } as any);

        const resolver = new VaultResolver({ url: "https://vault.example.com", token: "test-vault-token" });
        const secret = await resolver.getSecret("secret/data/stellar/mykey#my_custom_field");
        expect(secret).toBe(VALID_STELLAR_SECRET_4);
    });

    it("validates Stellar secret key format", async () => {
        const { VaultResolver, VaultSecretError } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: { data: { secret: "not-a-stellar-key" } } })
        } as any);

        const resolver = new VaultResolver({ url: "https://vault.example.com", token: "t" });
        await expect(resolver.getSecret("secret/data/x")).rejects.toThrow(VaultSecretError);
    });

    it("includes Vault namespace header when configured", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: { data: { secret: VALID_STELLAR_SECRET_5 } } })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "test-vault-token",
            namespace: "admin"
        });

        await resolver.getSecret("secret/data/x");
        const [, init] = mockFetch.mock.calls[0];
        expect((init as any).headers["X-Vault-Namespace"]).toBe("admin");
    });

    it("resolves secret via resolveSecretKey with vault: prefix", async () => {
        // Mock config loader to return vault config
        vi.mock("../../src/utils/config.js", () => ({
            loadConfig: () => ({
                network: "testnet",
                pollingIntervalSeconds: 300,
                vault: {
                    url: "https://vault.example.com",
                    token: TEST_VAULT_TOKEN
                }
            })
        }));

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: { data: { secret: VALID_STELLAR_SECRET_5 } } })
        } as any);

        // Need to re-import extension module to pick up mocked config
        vi.resetModules();
        const { resolveSecretKey } = await import("../../src/core/extension.js");

        const secret = await resolveSecretKey("vault:secret/data/stellar/mykey");
        expect(secret).toBe(VALID_STELLAR_SECRET_5);
    });
});
