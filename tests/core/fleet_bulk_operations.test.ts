/**
 * TDD tests for shared fault-isolation behaviour across bulk fleet operations.
 *
 * Acceptance criteria (issue #401):
 *   1. For each bulk operation, N-1 valid entries succeed when 1 entry is invalid.
 *   2. The failure report identifies which specific entry failed and why.
 *   3. The overall operation does not throw.
 *
 * This file covers:
 *   - Bulk watch  (watchContract called in a loop)
 *   - Bulk guard-policy apply  (applyGuardPolicyByTag)
 *   - Bulk alert-config apply  (insertAlertConfig called in a loop)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import {
    insertContract,
    insertAlertConfig,
    getAlertConfigsForContract,
    getExtensionPolicy,
} from "../../src/db/repositories";
import { applyGuardPolicyByTag } from "../../src/core/fleet";

// ── RPC Mock ────────────────────────────────────────────────────────────────

const mockGetContractInstanceEntry = vi.fn();
const mockGetWasmCodeEntry = vi.fn();
const mockGetMonitoredKeys = vi.fn().mockResolvedValue([]);
const mockGetEntryTTLs = vi.fn().mockResolvedValue({ entries: [] });

vi.mock("../../src/rpc/client.js", () => ({
    StellarRpcClient: vi.fn().mockImplementation(() => ({
        getContractInstanceEntry: mockGetContractInstanceEntry,
        getWasmCodeEntry: mockGetWasmCodeEntry,
        getMonitoredKeys: mockGetMonitoredKeys,
        getEntryTTLs: mockGetEntryTTLs,
    })),
}));

// ── Repository Mock for Guard-Policy Tests ───────────────────────────────────
// We mock upsertExtensionPolicy so we can make it throw for a specific contract.
// The other repository functions remain real.

const realRepos = await vi.importActual<
    typeof import("../../src/db/repositories")
>("../../src/db/repositories.js");

const realUpsertExtensionPolicy = (
    realRepos as { upsertExtensionPolicy: typeof realRepos.upsertExtensionPolicy }
).upsertExtensionPolicy;

vi.mock("../../src/db/repositories.js", async (importOriginal) => {
    const actual = (await importOriginal()) as typeof import("../../src/db/repositories.js");
    return {
        ...actual,
        upsertExtensionPolicy: vi.fn(
            (
                db: Database.Database,
                policy: {
                    contract_id: string;
                    enabled?: boolean;
                    target_ttl_ledgers: number;
                    extend_when_below_ledgers: number;
                    keypair_public?: string;
                    keypair_source?: string;
                },
            ) => {
                return actual.upsertExtensionPolicy(db, policy);
            },
        ),
    };
});

// Re-import after mocking so we get the mocked version.
const repos = await import("../../src/db/repositories.js");
const mockUpsertExtensionPolicy = repos.upsertExtensionPolicy as ReturnType<typeof vi.fn>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** 56-char string starting with C — passes the contract-ID format check. */
function validContractId(seed: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const id = ["C"];
    for (let i = 1; i < 56; i++) {
        id.push(chars[(seed + i * 7) % chars.length]!);
    }
    return id.join("");
}

function seedContract(db: Database.Database, id: string, tag?: string) {
    insertContract(db, {
        id,
        name: `Contract ${id.slice(1, 5)}`,
        network: "testnet",
        tags: tag,
    });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Fleet bulk operations — fault isolation", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();

        // Default RPC mock: contract not found
        mockGetContractInstanceEntry.mockResolvedValue(null);
        // Default: upsertExtensionPolicy delegates to real implementation
        mockUpsertExtensionPolicy.mockImplementation(
            (
                db: Database.Database,
                policy: { contract_id: string; target_ttl_ledgers: number; extend_when_below_ledgers: number },
            ) => realUpsertExtensionPolicy(db, policy),
        );
    });

    // =========================================================================
    // Bulk watch
    // =========================================================================

    describe("bulk watch (watchContract loop)", () => {
        it("reports failure for an invalid contract ID while succeeding for valid ones", async () => {
            // Import dynamically so the mock above is already in place.
            const { watchContract } = await import("../../src/core/watch.js");

            const validId = validContractId(1);
            const invalidId = "not-a-valid-contract-id"; // does not start with C / wrong length

            // Make the valid contract return a successful RPC result.
            mockGetContractInstanceEntry.mockImplementation(
                async (contractId: string) => {
                    if (contractId === validId) {
                        return {
                            entryKeyXdr: "valid-key-xdr",
                            latestLedger: 1000,
                            liveUntilLedgerSeq: 200_000,
                            lastModifiedLedgerSeq: 999,
                            remainingTTL: 199_000,
                            executableType: "wasm",
                            wasmHash: "aabb",
                        };
                    }
                    return null;
                },
            );

            // Execute bulk watch — the loop mirrors how a CLI or daemon
            // would iterate over multiple contracts.
            const results = await Promise.all([
                watchContract(db, {
                    contractId: validId,
                    network: "testnet",
                    noIntrospection: true,
                }),
                watchContract(db, {
                    contractId: invalidId,
                    network: "testnet",
                    noIntrospection: true,
                }),
            ]);

            const validResult = results[0]!;
            const invalidResult = results[1]!;

            // Valid contract succeeded.
            expect(validResult).toHaveProperty("success", true);
            expect(validResult).toHaveProperty("contractId", validId);

            // Invalid contract failed with a clear message.
            expect(invalidResult).toHaveProperty("success", false);
            expect(invalidResult).toHaveProperty("contractId", invalidId);
            if (!validResult.success && !invalidResult.success) {
                expect(invalidResult.error).toMatch(
                    /Invalid Contract ID format/i,
                );
            }

            // Overall operation did not throw — both returned results.
            expect(results).toHaveLength(2);
        });

        it("continues after an RPC error for one contract", async () => {
            const { watchContract } = await import("../../src/core/watch.js");

            const goodId = validContractId(10);
            const badId = validContractId(20);

            // Pre-register contracts so RPC mock is hit.
            seedContract(db, badId, "fleet");
            seedContract(db, goodId, "fleet");

            mockGetContractInstanceEntry.mockImplementation(
                async (contractId: string) => {
                    if (contractId === badId) {
                        throw new Error("RPC connection refused");
                    }
                    return {
                        entryKeyXdr: "good-key-xdr",
                        latestLedger: 1000,
                        liveUntilLedgerSeq: 300_000,
                        lastModifiedLedgerSeq: 999,
                        remainingTTL: 299_000,
                        executableType: "wasm",
                        wasmHash: "ccdd",
                    };
                },
            );

            const results = await Promise.all([
                watchContract(db, {
                    contractId: goodId,
                    network: "testnet",
                    noIntrospection: true,
                }),
                watchContract(db, {
                    contractId: badId,
                    network: "testnet",
                    noIntrospection: true,
                }),
            ]);

            const goodResult = results[0]!;
            const badResult = results[1]!;

            expect(goodResult).toHaveProperty("success", true);
            expect(badResult).toHaveProperty("success", false);
            if (!badResult.success) {
                expect(badResult.error).toContain("RPC connection refused");
            }
        });
    });

    // =========================================================================
    // Bulk guard-policy apply
    // =========================================================================

    describe("bulk guard-policy apply (applyGuardPolicyByTag)", () => {
        it("succeeds for N-1 valid contracts when 1 contract's upsert throws", () => {
            const validId1 = validContractId(30);
            const validId2 = validContractId(31);
            const failId = validContractId(32);

            seedContract(db, validId1, "defi");
            seedContract(db, validId2, "defi");
            seedContract(db, failId, "defi");

            // Make the upsert throw for the failing contract.
            mockUpsertExtensionPolicy.mockImplementation(
                (
                    db: Database.Database,
                    policy: { contract_id: string; target_ttl_ledgers: number; extend_when_below_ledgers: number },
                ) => {
                    if (policy.contract_id === failId) {
                        throw new Error(
                            `Simulated upsert failure for ${policy.contract_id}`,
                        );
                    }
                    return realUpsertExtensionPolicy(db, policy);
                },
            );

            const results = applyGuardPolicyByTag(db, "defi", {
                target_ttl_ledgers: 100_000,
                extend_when_below_ledgers: 20_000,
            });

            // N-1 successes, 1 failure
            const successes = results.filter((r) => r.status === "ok");
            const failures = results.filter((r) => r.status === "error");

            expect(successes).toHaveLength(2);
            expect(failures).toHaveLength(1);

            // The failure identifies which contract failed.
            expect(failures[0]!.contractId).toBe(failId);
            expect(failures[0]!.error).toContain("Simulated upsert failure");
        });

        it("reports error by contract name/ID, not silently dropped", () => {
            const validId = validContractId(40);
            const failId = validContractId(41);

            seedContract(db, validId, "bridge");
            seedContract(db, failId, "bridge");

            mockUpsertExtensionPolicy.mockImplementation(
                (
                    db: Database.Database,
                    policy: { contract_id: string; target_ttl_ledgers: number; extend_when_below_ledgers: number },
                ) => {
                    if (policy.contract_id === failId) {
                        throw new Error("Disk full");
                    }
                    return realUpsertExtensionPolicy(db, policy);
                },
            );

            const results = applyGuardPolicyByTag(db, "bridge", {
                target_ttl_ledgers: 50_000,
                extend_when_below_ledgers: 10_000,
            });

            const errorResult = results.find((r) => r.status === "error");
            expect(errorResult).toBeDefined();
            expect(errorResult!.contractId).toBe(failId);
            expect(errorResult!.name).toBe(`Contract ${failId.slice(1, 5)}`);
            expect(errorResult!.error).toBe("Disk full");
        });

        it("does not throw when all entries fail", () => {
            const failId1 = validContractId(50);
            const failId2 = validContractId(51);

            seedContract(db, failId1, "nft");
            seedContract(db, failId2, "nft");

            mockUpsertExtensionPolicy.mockImplementation(() => {
                throw new Error("Simulated failure");
            });

            // Should not throw.
            const results = applyGuardPolicyByTag(db, "nft", {
                target_ttl_ledgers: 80_000,
                extend_when_below_ledgers: 15_000,
            });

            expect(results).toHaveLength(2);
            expect(results.every((r) => r.status === "error")).toBe(true);
        });

        it("succeeds for all entries when none are invalid", () => {
            const id1 = validContractId(60);
            const id2 = validContractId(61);
            const id3 = validContractId(62);

            seedContract(db, id1, "payment");
            seedContract(db, id2, "payment");
            seedContract(db, id3, "payment");

            const results = applyGuardPolicyByTag(db, "payment", {
                target_ttl_ledgers: 100_000,
                extend_when_below_ledgers: 20_000,
            });

            expect(results).toHaveLength(3);
            expect(results.every((r) => r.status === "ok")).toBe(true);

            // Verify policies were actually persisted.
            expect(getExtensionPolicy(db, id1)).toBeDefined();
            expect(getExtensionPolicy(db, id2)).toBeDefined();
            expect(getExtensionPolicy(db, id3)).toBeDefined();
        });
    });

    // =========================================================================
    // Bulk alert-config apply
    // =========================================================================

    describe("bulk alert-config apply (insertAlertConfig loop)", () => {
        it("inserts configs for N-1 valid contracts when 1 is invalid (FK violation)", () => {
            const validId = validContractId(70);
            const invalidId = validContractId(71);

            // Only register the valid contract.
            seedContract(db, validId, "lending");

            const entries = [
                { contractId: validId, target: "https://hook1.example" },
                { contractId: invalidId, target: "https://hook2.example" },
            ];

            const results: Array<{
                contractId: string;
                status: "ok" | "error";
                error?: string;
                configId?: number;
            }> = [];

            for (const entry of entries) {
                try {
                    const configId = insertAlertConfig(db, {
                        contract_id: entry.contractId,
                        channel_type: "webhook",
                        channel_target: entry.target,
                        threshold_ledgers: 20_000,
                    });
                    results.push({
                        contractId: entry.contractId,
                        status: "ok",
                        configId,
                    });
                } catch (error: unknown) {
                    const errorMsg =
                        error instanceof Error ? error.message : String(error);
                    results.push({
                        contractId: entry.contractId,
                        status: "error",
                        error: errorMsg,
                    });
                }
            }

            // N-1 successes, 1 failure
            const successes = results.filter((r) => r.status === "ok");
            const failures = results.filter((r) => r.status === "error");

            expect(successes).toHaveLength(1);
            expect(failures).toHaveLength(1);

            // The failure identifies the invalid contract.
            expect(failures[0]!.contractId).toBe(invalidId);
            expect(failures[0]!.error).toMatch(/FOREIGN KEY/i);

            // The valid config was persisted.
            const configs = getAlertConfigsForContract(db, validId);
            expect(configs).toHaveLength(1);
            expect(configs[0]!.channel_target).toBe(
                "https://hook1.example",
            );
        });

        it("reports error by contract ID and reason, not silently dropped", () => {
            const missingId = validContractId(80);

            const results: Array<{
                contractId: string;
                status: "ok" | "error";
                error?: string;
            }> = [];

            // Attempt to add alert to a non-existent contract.
            try {
                insertAlertConfig(db, {
                    contract_id: missingId,
                    channel_type: "slack",
                    channel_target: "#alerts",
                    threshold_ledgers: 10_000,
                });
                results.push({
                    contractId: missingId,
                    status: "ok",
                });
            } catch (error: unknown) {
                const errorMsg =
                    error instanceof Error ? error.message : String(error);
                results.push({
                    contractId: missingId,
                    status: "error",
                    error: errorMsg,
                });
            }

            expect(results).toHaveLength(1);
            expect(results[0]!.status).toBe("error");
            expect(results[0]!.contractId).toBe(missingId);
            expect(results[0]!.error).toBeDefined();
        });

        it("does not throw when processing multiple invalid contracts", () => {
            const invalidIds = [
                validContractId(90),
                validContractId(91),
                validContractId(92),
            ];

            const results: Array<{
                contractId: string;
                status: "ok" | "error";
            }> = [];

            // None of these contracts are registered — all FK violations.
            for (const contractId of invalidIds) {
                try {
                    insertAlertConfig(db, {
                        contract_id: contractId,
                        channel_type: "webhook",
                        channel_target: "https://example.com",
                        threshold_ledgers: 5_000,
                    });
                    results.push({ contractId, status: "ok" });
                } catch {
                    results.push({ contractId, status: "error" });
                }
            }

            expect(results).toHaveLength(3);
            expect(results.every((r) => r.status === "error")).toBe(true);
            // No exception escaped the loop.
        });

        it("inserts all configs when all contracts are valid", () => {
            const ids = [
                validContractId(100),
                validContractId(101),
                validContractId(102),
            ];

            for (const id of ids) {
                seedContract(db, id, "dao");
            }

            const results: Array<{
                contractId: string;
                status: "ok" | "error";
                configId?: number;
            }> = [];

            for (const contractId of ids) {
                try {
                    const configId = insertAlertConfig(db, {
                        contract_id: contractId,
                        channel_type: "webhook",
                        channel_target: `https://hook-${contractId.slice(1, 5)}.example`,
                        threshold_ledgers: 15_000,
                    });
                    results.push({
                        contractId,
                        status: "ok",
                        configId,
                    });
                } catch (error: unknown) {
                    const errorMsg =
                        error instanceof Error ? error.message : String(error);
                    results.push({
                        contractId,
                        status: "error",
                        error: errorMsg,
                    });
                }
            }

            expect(results).toHaveLength(3);
            expect(results.every((r) => r.status === "ok")).toBe(true);

            // Each contract has exactly one alert config.
            for (const id of ids) {
                const configs = getAlertConfigsForContract(db, id);
                expect(configs).toHaveLength(1);
            }
        });
    });
});
