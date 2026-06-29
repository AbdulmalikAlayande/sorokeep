import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We will import after mocking
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
                        secret_key: "SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56)
                    },
                    metadata: { version: 1 }
                }
            })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "hvs.testtoken"
        });

        const secret = await resolver.getSecret("secret/data/stellar/mykey");

        expect(secret).toBe("SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56));
        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("https://vault.example.com/v1/secret/data/stellar/mykey");
        expect((init as any).headers["X-Vault-Token"]).toBe("hvs.testtoken");
    });

    it("fetches valid secret keys from Vault endpoint (KV v1)", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: {
                    private_key: "SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56)
                }
            })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "hvs.testtoken"
        });

        const secret = await resolver.getSecret("secret/stellar/mykey");
        expect(secret).toBe("SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56));
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
            token: "hvs.testtoken"
        });

        await expect(resolver.getSecret("secret/data/missing"))
            .rejects.toThrow(VaultSecretNotFoundError);
    });

    it("extracts secret from multiple common field names", async () => {
        const { VaultResolver } = await import("../../src/core/vault.js");

        const testCases = [
            { field: "secret", value: "SB7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56) },
            { field: "value", value: "SAAAAAAAAAAAAAAA" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".substring(0, 56) },
            { field: "stellar_secret", value: "SC7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56) },
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
                data: { data: { my_custom_field: "SD7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56) } }
            })
        } as any);

        const resolver = new VaultResolver({ url: "https://vault.example.com", token: "t" });
        const secret = await resolver.getSecret("secret/data/stellar/mykey#my_custom_field");
        expect(secret).toContain("SD7Q");
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
            json: async () => ({ data: { data: { secret: "SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56) } } })
        } as any);

        const resolver = new VaultResolver({
            url: "https://vault.example.com",
            token: "t",
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
                    token: "hvs.testtoken"
                }
            })
        }));

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: { data: { secret: "SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56) } } })
        } as any);

        // Need to re-import extension module to pick up mocked config
        vi.resetModules();
        const { resolveSecretKey } = await import("../../src/core/extension.js");

        const secret = await resolveSecretKey("vault:secret/data/stellar/mykey");
        expect(secret).toBe("SA7QYNF7SOWQ3GLR" + "2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ".substring(0, 56));
    });
});
