import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
    GUARD_PRESETS,
    PRESET_NAMES,
    getPreset,
} from "../../src/core/guard-presets";
import { registerGuardCommand } from "../../src/commands/guard";
import { getDatabaseForTesting } from "../../src/db/database";
import { insertContract, getExtensionPolicy } from "../../src/db/repositories";

const VALID_TEST_SECRET = "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG";
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

describe("guard-presets constants module", () => {
    it("exports exactly three preset names", () => {
        expect(PRESET_NAMES).toHaveLength(3);
    });

    it("exports the three canonical preset names in order", () => {
        expect(PRESET_NAMES).toEqual(["conservative", "balanced", "aggressive"]);
    });

    it("GUARD_PRESETS has an entry for every name in PRESET_NAMES", () => {
        for (const name of PRESET_NAMES) {
            expect(GUARD_PRESETS).toHaveProperty(name);
        }
    });

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

    it("conservative has the highest targetTtl among all presets", () => {
        const ttls = PRESET_NAMES.map((n) => GUARD_PRESETS[n].targetTtl);
        expect(GUARD_PRESETS.conservative.targetTtl).toBe(Math.max(...ttls));
    });

    it("aggressive has the lowest targetTtl among all presets", () => {
        const ttls = PRESET_NAMES.map((n) => GUARD_PRESETS[n].targetTtl);
        expect(GUARD_PRESETS.aggressive.targetTtl).toBe(Math.min(...ttls));
    });

    it("getPreset('conservative') returns the conservative preset", () => {
        const preset = getPreset("conservative");
        expect(preset).toBeDefined();
        expect(preset!.targetTtl).toBe(518_400);
        expect(preset!.threshold).toBe(103_680);
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

describe("guard apply --preset integration (real DB, via current 'apply' default subcommand)", () => {
    beforeEach(() => {
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
        delete process.env.STELLAR_TEST_KEY;
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
    });

    it("rejects an unknown preset name with exit code 1", async () => {
        const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "turbo",
        ]);

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockError).toHaveBeenCalledWith(expect.stringMatching(/unknown preset.*turbo/i));
    });

    it("exits with code 1 when --preset and --target-ttl are both given", async () => {
        process.env.STELLAR_TEST_KEY = VALID_TEST_SECRET;
        const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

        const program = new Command();
        registerGuardCommand(program);
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
    });

    it("exits with code 1 when --preset and --threshold are both given", async () => {
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
    });

    it("--preset with --disable persists the preset's TTL values but enabled=false", async () => {
        const program = new Command();
        registerGuardCommand(program);
        await program.parseAsync([
            "node", "sorokeep",
            "guard", TEST_CONTRACT_ID,
            "--preset", "conservative",
            "--disable",
        ]);

        const policy = getExtensionPolicy(sharedDb, TEST_CONTRACT_ID);
        expect(policy).toBeDefined();
        expect(policy!.target_ttl_ledgers).toBe(518_400);
        expect(policy!.extend_when_below_ledgers).toBe(103_680);
        expect(policy!.enabled).toBeFalsy();
    });
});
