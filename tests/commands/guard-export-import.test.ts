import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, upsertExtensionPolicy, getExtensionPolicy } from "../../src/db/repositories";
import { exportExtensionPolicy, importExtensionPolicy } from "../../src/commands/guard";
import type Database from "better-sqlite3";

// A genuine Stellar secret key used for testing (safe — only for testing)
const VALID_TEST_SECRET = "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG";
const VALID_TEST_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";
const TEST_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TEST_CONTRACT_ID_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

describe("Guard Export/Import - TDD Requirements", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        insertContract(db, {
            id: TEST_CONTRACT_ID,
            name: "Test Contract",
            network: "testnet",
        });
        insertContract(db, {
            id: TEST_CONTRACT_ID_2,
            name: "Test Contract 2",
            network: "testnet",
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("exportExtensionPolicy", () => {
        it("exports a valid extension policy with env keypair source", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            expect(exported).toBeDefined();
            expect(exported.contract_id).toBe(TEST_CONTRACT_ID);
            expect(exported.enabled).toBe(true);
            expect(exported.target_ttl_ledgers).toBe(100000);
            expect(exported.extend_when_below_ledgers).toBe(20000);
            expect(exported.keypair_public).toBe(VALID_TEST_PUBKEY);
            expect(exported.keypair_source).toBe("env:STELLAR_KEY");
        });

        it("exports a valid extension policy with vault keypair source", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 50000,
                extend_when_below_ledgers: 10000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "vault:secret/data/stellar/key",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            expect(exported).toBeDefined();
            expect(exported.keypair_source).toBe("vault:secret/data/stellar/key");
        });

        it("throws an error when contract has no extension policy", () => {
            expect(() => {
                exportExtensionPolicy(db, TEST_CONTRACT_ID);
            }).toThrow("No extension policy found for contract");
        });

        it("SECURITY: exported JSON never contains a raw secret key (keypair_public only)", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);
            const exportedJSON = JSON.stringify(exported);

            // Verify the secret key does NOT appear anywhere in the export
            expect(exportedJSON).not.toContain(VALID_TEST_SECRET);
            // Verify only public key is present
            expect(exported.keypair_public).toBe(VALID_TEST_PUBKEY);
            // Verify keypair_source is a reference, not the actual secret
            expect(exported.keypair_source).toMatch(/^(env:|vault:)/);
        });

        it("SECURITY: exported JSON never contains keypair_source with raw secret (only env: or vault: prefixes)", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:MY_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            // Exported keypair_source must be a reference (env: or vault:)
            expect(exported.keypair_source).toMatch(/^(env:|vault:)/);
            // Must not be a raw secret starting with 'S'
            expect(exported.keypair_source).not.toMatch(/^S[A-Z0-9]{55}$/);
        });

        it("excludes internal database fields (id, created_at)", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            // Should not contain internal DB fields
            expect(exported).not.toHaveProperty("id");
            expect(exported).not.toHaveProperty("created_at");
        });

        it("handles policy without keypair (manual extension only)", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: false,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            expect(exported).toBeDefined();
            expect(exported.keypair_public).toBeNull();
            expect(exported.keypair_source).toBeNull();
            expect(exported.enabled).toBe(false);
        });
    });

    describe("importExtensionPolicy", () => {
        it("imports a valid exported policy to a new contract", () => {
            // Export from first contract
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            // Import to second contract
            importExtensionPolicy(db, TEST_CONTRACT_ID_2, exported);

            const imported = getExtensionPolicy(db, TEST_CONTRACT_ID_2);
            expect(imported).toBeDefined();
            expect(imported!.contract_id).toBe(TEST_CONTRACT_ID_2);
            expect(imported!.enabled).toBeTruthy();
            expect(imported!.target_ttl_ledgers).toBe(100000);
            expect(imported!.extend_when_below_ledgers).toBe(20000);
            expect(imported!.keypair_public).toBe(VALID_TEST_PUBKEY);
            expect(imported!.keypair_source).toBe("env:STELLAR_KEY");
        });

        it("SECURITY: rejects import containing a raw secret key field", () => {
            const maliciousExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
                keypair_secret: VALID_TEST_SECRET, // Malicious field
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, maliciousExport as any);
            }).toThrow("Import contains forbidden secret key field");
        });

        it("SECURITY: rejects import with keypair_source containing a raw secret key", () => {
            const maliciousExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: VALID_TEST_SECRET, // Raw secret instead of env:/vault: reference
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, maliciousExport);
            }).toThrow("keypair_source must be an env: or vault: reference");
        });

        it("validates required fields in import", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                // Missing target_ttl_ledgers
                extend_when_below_ledgers: 20000,
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport as any);
            }).toThrow("Missing required field");
        });

        it("validates target_ttl_ledgers is a positive number", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: -100,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:KEY",
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport);
            }).toThrow("target_ttl_ledgers must be a positive number");
        });

        it("validates extend_when_below_ledgers is a positive number", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 0,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:KEY",
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport);
            }).toThrow("extend_when_below_ledgers must be a positive number");
        });

        it("validates threshold is less than target TTL", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 150000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:KEY",
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport);
            }).toThrow("extend_when_below_ledgers must be less than target_ttl_ledgers");
        });

        it("allows null keypair fields for manual-only policies", () => {
            const exportWithoutKeypair = {
                contract_id: TEST_CONTRACT_ID,
                enabled: false,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: null,
                keypair_source: null,
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, exportWithoutKeypair);
            }).not.toThrow();

            const imported = getExtensionPolicy(db, TEST_CONTRACT_ID_2);
            expect(imported!.keypair_public).toBeNull();
            expect(imported!.keypair_source).toBeNull();
        });

        it("validates keypair_public is a valid Stellar public key format when provided", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: "INVALID_PUBLIC_KEY",
                keypair_source: "env:KEY",
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport);
            }).toThrow("keypair_public must be a valid Stellar public key");
        });

        it("validates both keypair_public and keypair_source are present together or both null", () => {
            const invalidExport = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: null, // Missing source
            };

            expect(() => {
                importExtensionPolicy(db, TEST_CONTRACT_ID_2, invalidExport);
            }).toThrow("keypair_public and keypair_source must both be present or both null");
        });

        it("overwrites existing policy when importing to a contract with an existing policy", () => {
            // Create initial policy
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID_2,
                enabled: false,
                target_ttl_ledgers: 50000,
                extend_when_below_ledgers: 10000,
            });

            // Export a different policy
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);

            // Import should overwrite
            importExtensionPolicy(db, TEST_CONTRACT_ID_2, exported);

            const imported = getExtensionPolicy(db, TEST_CONTRACT_ID_2);
            expect(imported!.target_ttl_ledgers).toBe(100000);
            expect(imported!.keypair_public).toBe(VALID_TEST_PUBKEY);
        });

        it("ignores the contract_id field in the export and uses the target contract_id", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);
            // Export contains original contract_id
            expect(exported.contract_id).toBe(TEST_CONTRACT_ID);

            // Import to different contract
            importExtensionPolicy(db, TEST_CONTRACT_ID_2, exported);

            const imported = getExtensionPolicy(db, TEST_CONTRACT_ID_2);
            // Should be stored under the new contract_id
            expect(imported!.contract_id).toBe(TEST_CONTRACT_ID_2);
        });
    });

    describe("JSON serialization round-trip", () => {
        it("successfully round-trips export → JSON → parse → import", () => {
            upsertExtensionPolicy(db, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const exported = exportExtensionPolicy(db, TEST_CONTRACT_ID);
            const jsonString = JSON.stringify(exported, null, 2);
            const parsed = JSON.parse(jsonString);

            importExtensionPolicy(db, TEST_CONTRACT_ID_2, parsed);

            const imported = getExtensionPolicy(db, TEST_CONTRACT_ID_2);
            expect(imported!.enabled).toBeTruthy();
            expect(imported!.target_ttl_ledgers).toBe(100000);
            expect(imported!.extend_when_below_ledgers).toBe(20000);
            expect(imported!.keypair_public).toBe(VALID_TEST_PUBKEY);
            expect(imported!.keypair_source).toBe("env:STELLAR_KEY");
        });
    });
});
