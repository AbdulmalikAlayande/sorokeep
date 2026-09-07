import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerGuardCommand } from "../../src/commands/guard";
import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, upsertExtensionPolicy } from "../../src/db/repositories";
import type Database from "better-sqlite3";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const VALID_TEST_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";
const TEST_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TEST_CONTRACT_ID_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

let sharedDb: Database.Database;

vi.mock("../../src/db/database", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => sharedDb,
    };
});

describe("Guard Export/Import CLI Integration", () => {
    let tempDir: string;

    beforeEach(async () => {
        sharedDb = getDatabaseForTesting();
        insertContract(sharedDb, {
            id: TEST_CONTRACT_ID,
            name: "Test Contract",
            network: "testnet",
        });
        insertContract(sharedDb, {
            id: TEST_CONTRACT_ID_2,
            name: "Test Contract 2",
            network: "testnet",
        });

        // Create temp directory for test files
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sorokeep-test-"));

        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        // Clean up temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe("guard export", () => {
        it("exports policy to stdout when no --out specified", async () => {
            upsertExtensionPolicy(sharedDb, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                TEST_CONTRACT_ID,
            ]);

            // Should have logged JSON to stdout
            expect(console.log).toHaveBeenCalled();
            const loggedOutput = vi.mocked(console.log).mock.calls
                .map(call => call[0])
                .join("\n");
            
            const parsed = JSON.parse(loggedOutput);
            expect(parsed.contract_id).toBe(TEST_CONTRACT_ID);
            expect(parsed.enabled).toBe(true);
            expect(parsed.target_ttl_ledgers).toBe(100000);
        });

        it("exports policy to file when --out is specified", async () => {
            upsertExtensionPolicy(sharedDb, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const outputFile = path.join(tempDir, "policy.json");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                TEST_CONTRACT_ID,
                "--out", outputFile,
            ]);

            // File should exist
            const content = await fs.readFile(outputFile, "utf-8");
            const parsed = JSON.parse(content);
            
            expect(parsed.contract_id).toBe(TEST_CONTRACT_ID);
            expect(parsed.enabled).toBe(true);
            expect(parsed.keypair_public).toBe(VALID_TEST_PUBKEY);
        });

        it("SECURITY: exported file never contains raw secret keys", async () => {
            upsertExtensionPolicy(sharedDb, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const outputFile = path.join(tempDir, "policy.json");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                TEST_CONTRACT_ID,
                "--out", outputFile,
            ]);

            const content = await fs.readFile(outputFile, "utf-8");
            
            // Should not contain any secret key patterns (starting with 'S')
            expect(content).not.toMatch(/S[A-Z0-9]{55}/);
            // Should only contain env: or vault: references
            expect(content).toContain("env:STELLAR_KEY");
            // Should contain public key
            expect(content).toContain(VALID_TEST_PUBKEY);
        });

        it("fails gracefully when contract has no policy", async () => {
            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                TEST_CONTRACT_ID,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("No extension policy found")
            );
        });

        it("fails gracefully when contract not found", async () => {
            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                "INVALID_CONTRACT_ID",
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("not found")
            );
        });
    });

    describe("guard import", () => {
        it("imports policy from file when --file is specified", async () => {
            const policyFile = path.join(tempDir, "policy.json");
            const policyData = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            };
            await fs.writeFile(policyFile, JSON.stringify(policyData, null, 2), "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining("imported successfully")
            );

            // Verify policy was imported
            const imported = sharedDb.prepare(
                "SELECT * FROM extension_policies WHERE contract_id = ?"
            ).get(TEST_CONTRACT_ID_2) as any;

            expect(imported).toBeDefined();
            expect(imported.contract_id).toBe(TEST_CONTRACT_ID_2);
            expect(imported.target_ttl_ledgers).toBe(100000);
            expect(imported.keypair_public).toBe(VALID_TEST_PUBKEY);
        });

        it("SECURITY: rejects import file containing secret key fields", async () => {
            const policyFile = path.join(tempDir, "malicious-policy.json");
            const maliciousData = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
                keypair_secret: "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG",
            };
            await fs.writeFile(policyFile, JSON.stringify(maliciousData), "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("forbidden secret key field")
            );
        });

        it("SECURITY: rejects import with raw secret in keypair_source", async () => {
            const policyFile = path.join(tempDir, "malicious-policy.json");
            const maliciousData = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG",
            };
            await fs.writeFile(policyFile, JSON.stringify(maliciousData), "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("must be an env: or vault: reference")
            );
        });

        it("validates JSON structure on import", async () => {
            const policyFile = path.join(tempDir, "invalid-policy.json");
            const invalidData = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                // Missing target_ttl_ledgers
                extend_when_below_ledgers: 20000,
            };
            await fs.writeFile(policyFile, JSON.stringify(invalidData), "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("Missing required field")
            );
        });

        it("fails gracefully when contract not found", async () => {
            const policyFile = path.join(tempDir, "policy.json");
            const policyData = {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            };
            await fs.writeFile(policyFile, JSON.stringify(policyData), "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                "INVALID_CONTRACT_ID",
                "--file", policyFile,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining("not found")
            );
        });

        it("fails gracefully with malformed JSON", async () => {
            const policyFile = path.join(tempDir, "malformed.json");
            await fs.writeFile(policyFile, "{ invalid json }", "utf-8");

            const program = new Command();
            registerGuardCommand(program);

            await program.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            expect(process.exit).toHaveBeenCalledWith(1);
            expect(console.error).toHaveBeenCalled();
        });
    });

    describe("export → import round-trip", () => {
        it("successfully exports and imports a policy between contracts", async () => {
            // Setup: Create policy on first contract
            upsertExtensionPolicy(sharedDb, {
                contract_id: TEST_CONTRACT_ID,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_public: VALID_TEST_PUBKEY,
                keypair_source: "env:STELLAR_KEY",
            });

            const policyFile = path.join(tempDir, "exported-policy.json");

            // Export
            const exportProgram = new Command();
            registerGuardCommand(exportProgram);
            await exportProgram.parseAsync([
                "node", "sorokeep",
                "guard", "export",
                TEST_CONTRACT_ID,
                "--out", policyFile,
            ]);

            // Import to second contract
            const importProgram = new Command();
            registerGuardCommand(importProgram);
            await importProgram.parseAsync([
                "node", "sorokeep",
                "guard", "import",
                TEST_CONTRACT_ID_2,
                "--file", policyFile,
            ]);

            // Verify
            const imported = sharedDb.prepare(
                "SELECT * FROM extension_policies WHERE contract_id = ?"
            ).get(TEST_CONTRACT_ID_2) as any;

            expect(imported).toBeDefined();
            expect(imported.contract_id).toBe(TEST_CONTRACT_ID_2);
            expect(imported.enabled).toBeTruthy();
            expect(imported.target_ttl_ledgers).toBe(100000);
            expect(imported.extend_when_below_ledgers).toBe(20000);
            expect(imported.keypair_public).toBe(VALID_TEST_PUBKEY);
            expect(imported.keypair_source).toBe("env:STELLAR_KEY");
        });
    });
});
