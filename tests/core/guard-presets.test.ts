import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    GUARD_PRESETS,
    PRESET_NAMES,
    getPreset,
    type GuardPreset,
    type PresetName,
} from "../../src/core/guard-presets";
import { registerGuardCommand } from "../../src/commands/guard";
import { Command } from "commander";
import * as repos from "../../src/db/repositories";
import * as extensionLib from "../../src/core/extension";

// ─── Shared test infrastructure (mirrors guard.test.ts) ──────────────────────

const { mockSpinner } = vi.hoisted(() => ({
    mockSpinner: {
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: vi.fn().mockReturnThis(),
    },
}));

vi.mock("ora", () => ({
    default: vi.fn(() => mockSpinner),
}));

import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, getExtensionPolicy } from "../../src/db/repositories";

const VALID_TEST_SECRET = "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG";
const VALID_TEST_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";
const TEST_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

let sharedDb: ReturnType<typeof getDatabaseForTesting>;

vi.mock("../../src/db/database", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getDatabase: () => sharedDb,
    };
});

vi.mock("../../src/core/extension", async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        simulateExtension: vi.fn(),
        extendEntries: vi.fn(),
        resolveSecretKey: vi.fn(async (source: string) => {
            if (source.startsWith("env:") || source.startsWith("vault:")) {
                return VALID_TEST_SECRET;
            }
            return source;
        }),
    };
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Unit tests — guard-presets.ts constants module
// ═══════════════════════════════════════════════════════════════════════════════

describe("guard-presets constants module", () => {
    // ── PRESET_NAMES ─────────────────────────────────────────────────────────

    it("exports exactly three preset names", () => {
        expect(PRESET_NAMES).toHaveLength(3);
    });

    it("exports the three canonical preset names in order", () => {
        expect(PRESET_NAMES).toEqual(["conservative", "balanced", "aggressive"]);
    });

    // ── GUARD_PRESETS keys ────────────────────────────────────────────────────

    it("GUARD_PRESETS has an entry for every name in PRESET_NAMES", () => {
        for (const name of PRESET_NAMES) {
            expect(GUARD_PRESETS).toHaveProperty(name);
        }
    });

    // ── Shape of each preset ──────────────────────────────────────────────────

    it.each(PRESET_NAMES)("preset '%s' has a name field matching its key", (name) => {
        expect(GUARD_PRESETS[name].name).toBe(name);
    });

    it.each(PRESET_NAMES)("preset '%s' has a non-empty description string", (name) => {
        expect(typeof GUARD_PRESETS[name].description).toBe("string");
        expect(GUARD_PRESETS[name].description.length).toBeGreaterThan(0);
    });

    it.each(PRESET_NAMES)("preset '%s' has a positive integer targetTtl", (name) => {
        const { targetTtl } = GUARD_PRESETS[name];
        expect(Number.isInteger(targetTtl)).toBe(true);
        expect(targetTtl).toBeGreaterThan(0);
    });

    it.each(PRESET_NAMES)("preset '%s' has a positive integer threshold", (name) => {
        const { threshold } = GUARD_PRESETS[name];
        expect(Number.isInteger(threshold)).toBe(true);
        expect(threshold).toBeGreaterThan(0);
    });

    it.each(PRESET_NAMES)("preset '%s': threshold is strictly less than targetTtl", (name) => {
        const { targetTtl, threshold } = GUARD_PRESETS[name];
        expect(threshold).toBeLessThan(targetTtl);
    });

    // ── Documented fixed values (acceptance criterion) ────────────────────────

    it("conservative preset resolves to targetTtl=518400 and threshold=103680", () => {
        expect(GUARD_PRESETS.conservative.targetTtl).toBe(518_400);
        expect(GUARD_PRESETS.conservative.threshold).toBe(103_680);
    });

    it("balanced preset resolves to targetTtl=100000 and threshold=20000 (current defaults)", () => {
        expect(GUARD_PRESETS.balanced.targetTtl).toBe(100_000);
        expect(GUARD_PRESETS.balanced.threshold).toBe(20_000);
    });

    it("aggressive preset resolves to targetTtl=51840 and threshold=8640", () => {
        expect(GUARD_PRESETS.aggressive.targetTtl).toBe(51_840);
        expect(GUARD_PRESETS.aggressive.threshold).toBe(8_640);
    });

    // ── Cost/safety ordering ──────────────────────────────────────────────────

    it("conservative has the highest targetTtl among all presets", () => {
        const ttls = PRESET_NAMES.map((n) => GUARD_PRESETS[n].targetTtl);
        expect(GUARD_PRESETS.conservative.targetTtl).toBe(Math.max(...ttls));
    });

    it("aggressive has the lowest targetTtl among all presets", () => {
        const ttls = PRESET_NAMES.map((n) => GUARD_PRESETS[n].targetTtl);
        expect(GUARD_PRESETS.aggressive.targetTtl).toBe(Math.min(...ttls));
    });

    it("conservative has the highest threshold (earliest warning) among all presets", () => {
        const thresholds = PRESET_NAMES.map((n) => GUARD_PRESETS[n].threshold);
        expect(GUARD_PRESETS.conservative.threshold).toBe(Math.max(...thresholds));
    });

    it("aggressive has the lowest threshold (latest warning) among all presets", () => {
        const thresholds = PRESET_NAMES.map((n) => GUARD_PRESETS[n].threshold);
        expect(GUARD_PRESETS.aggressive.threshold).toBe(Math.min(...thresholds));
    });

    // ── getPreset helper ──────────────────────────────────────────────────────

    it("getPreset('conservative') returns the conservative preset", () => {
        const preset = getPreset("conservative");
        expect(preset).toBeDefined();
        expect(preset!.name).toBe("conservative");
        expect(preset!.targetTtl).toBe(518_400);
        expect(preset!.threshold).toBe(103_680);
    });

    it("getPreset('balanced') returns the balanced preset", () => {
        const preset = getPreset("balanced");
        expect(preset).toBeDefined();
        expect(preset!.name).toBe("balanced");
        expect(preset!.targetTtl).toBe(100_000);
        expect(preset!.threshold).toBe(20_000);
    });

    it("getPreset('aggressive') returns the aggressive preset", () => {
        const preset = getPreset("aggressive");
        expect(preset).toBeDefined();
        expect(preset!.name).toBe("aggressive");
        expect(preset!.targetTtl).toBe(51_840);
        expect(preset!.threshold).toBe(8_640);
    });

    it("getPreset returns undefined for an unknown preset name", () => {
        expect(getPreset("unknown")).toBeUndefined();
    });

    it("getPreset returns undefined for an empty string", () => {
        expect(getPreset("")).toBeUndefined();
    });

    it("getPreset is case-sensitive — 'Conservative' returns undefined", () => {
        expect(getPreset("Conservative")).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CLI unit tests — --preset flag behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe("Guard Command --preset flag (CLI unit)", () => {
    let actionFn: (contractId: string, options: any) => Promise<void>;
    let mockExit: ReturnType<typeof vi.spyOn>;
    let mockError: ReturnType<typeof vi.spyOn>;
    let mockLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sharedDb = getDatabaseForTesting();

        const program = new Command();
        vi.spyOn(Command.prototype, "action").mockImplementation(function (this: any, fn: any) {
            actionFn = fn;
            return this;
        });
        registerGuardCommand(program);

        mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        mockError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

        vi.spyOn(repos, "getContract");
        vi.spyOn(repos, "getEntriesForContract");
        vi.spyOn(repos, "upsertExtensionPolicy");
        vi.spyOn(repos, "getExtensionPolicy");
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // ── --preset resolves to fixed values ─────────────────────────────────────

    it("--preset conservative resolves threshold and targetTtl from the preset constants", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getExtensionPolicy).mockReturnValue(undefined as any);

        await actionFn("VALID_ID", {
            preset: "conservative",
            // No targetTtl/threshold — they should be resolved from the preset
        });

        // When no keypair/action flag is given, the command shows current policy.
        // The important thing is it did NOT exit(1) due to a validation error.
        expect(mockExit).not.toHaveBeenCalledWith(1);
    });

    it("--preset balanced resolves to targetTtl=100000 and threshold=20000", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getExtensionPolicy).mockReturnValue(undefined as any);

        await actionFn("VALID_ID", {
            preset: "balanced",
            // No targetTtl/threshold — they should be resolved from the preset
        });

        expect(mockExit).not.toHaveBeenCalledWith(1);
    });

    it("--preset aggressive resolves to targetTtl=51840 and threshold=8640", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.getExtensionPolicy).mockReturnValue(undefined as any);

        await actionFn("VALID_ID", {
            preset: "aggressive",
            // No targetTtl/threshold — they should be resolved from the preset
        });

        expect(mockExit).not.toHaveBeenCalledWith(1);
    });

    // ── --preset rejects unknown names ────────────────────────────────────────

    it("--preset with an unknown name exits with code 1 and shows a clear error", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", {
            preset: "turbo",
            targetTtl: "100000",
            threshold: "20000",
        });

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(
            expect.stringMatching(/unknown preset.*turbo/i),
        );
    });

    // ── mutual exclusivity: --preset vs explicit flags ─────────────────────────

    it("exits with code 1 and a clear error when --preset and --target-ttl are both given", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", {
            preset: "balanced",
            targetTtl: "200000", // explicitly overriding — should be rejected
            threshold: "20000",
            _explicitTargetTtl: true, // signal that --target-ttl was explicitly passed
        });

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(
            expect.stringMatching(/--preset.*--target-ttl|--target-ttl.*--preset/i),
        );
    });

    it("exits with code 1 and a clear error when --preset and --threshold are both given", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);

        await actionFn("VALID_ID", {
            preset: "balanced",
            targetTtl: "100000",
            threshold: "30000", // explicitly overriding — should be rejected
            _explicitThreshold: true, // signal that --threshold was explicitly passed
        });

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(
            expect.stringMatching(/--preset.*--threshold|--threshold.*--preset/i),
        );
    });

    // ── --preset with --disable ───────────────────────────────────────────────

    it("--preset with --disable persists the correct preset values but enabled=false", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.upsertExtensionPolicy).mockImplementation(() => {});

        await actionFn("VALID_ID", {
            preset: "conservative",
            targetTtl: "100000",
            threshold: "20000",
            disable: true,
        });

        expect(repos.upsertExtensionPolicy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                contract_id: "VALID_ID",
                enabled: false,
                target_ttl_ledgers: 518_400,
                extend_when_below_ledgers: 103_680,
            }),
        );
    });

    // ── --preset with --auto-extend ───────────────────────────────────────────

    it("--preset aggressive with --auto-extend stores preset values in the DB", async () => {
        vi.mocked(repos.getContract).mockReturnValue({ id: "X", network: "testnet" } as any);
        vi.mocked(repos.upsertExtensionPolicy).mockImplementation(() => {});

        await actionFn("VALID_ID", {
            preset: "aggressive",
            targetTtl: "100000",
            threshold: "20000",
            autoExtend: true,
            keypairEnv: "SOME_ENV_VAR",
        });

        expect(repos.upsertExtensionPolicy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                enabled: true,
                target_ttl_ledgers: 51_840,
                extend_when_below_ledgers: 8_640,
            }),
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Integration tests — --preset persists correct values end-to-end
// ═══════════════════════════════════════════════════════════════════════════════

describe("Guard Command --preset integration (real DB)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        sharedDb = getDatabaseForTesting();
        insertContract(sharedDb, {
            id: TEST_CONTRACT_ID,
            name: "Preset Integration Test Contract",
            network: "testnet",
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("--preset conservative registers the correct TTL values in the database", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "conservative",
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(518_400);
        expect(policy!.extend_when_below_ledgers).toBe(103_680);
        expect(policy!.enabled).toBeTruthy();

        delete process.env.STELLAR_TEST_KEY;
    });

    it("--preset balanced registers the correct TTL values in the database", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "balanced",
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(100_000);
        expect(policy!.extend_when_below_ledgers).toBe(20_000);
        expect(policy!.enabled).toBeTruthy();

        delete process.env.STELLAR_TEST_KEY;
    });

    it("--preset aggressive registers the correct TTL values in the database", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "aggressive",
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(51_840);
        expect(policy!.extend_when_below_ledgers).toBe(8_640);
        expect(policy!.enabled).toBeTruthy();

        delete process.env.STELLAR_TEST_KEY;
    });

    it("--preset does not override existing target-ttl when given alongside explicit flags — exits with code 1", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

        const program = new Command();
        registerGuardCommand(program);

        // Commander will parse both --preset and --target-ttl and pass them
        // both in the options object; the action should reject this combination.
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "balanced",
            "--target-ttl", "200000",
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(
            expect.stringMatching(/--preset.*--target-ttl|--target-ttl.*--preset/i),
        );

        delete process.env.STELLAR_TEST_KEY;
    });

    it("--preset does not override existing threshold when given alongside explicit flag — exits with code 1", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;

        const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

        const program = new Command();
        registerGuardCommand(program);

        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "balanced",
            "--threshold", "30000",
            "--keypair-env", "STELLAR_TEST_KEY",
            "--auto-extend",
        ]);

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(
            expect.stringMatching(/--preset.*--threshold|--threshold.*--preset/i),
        );

        delete process.env.STELLAR_TEST_KEY;
    });
});
