import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Tests for the devnet sandbox compose override (docker-compose.devnet.yaml).
 *
 * The devnet compose is meant to be used together with the base compose via:
 *   docker compose -f docker-compose.yaml -f docker-compose.devnet.yaml up
 *
 * It provides:
 *   - A local Stellar Quickstart sandbox with unlimited Soroban RPC limits
 *   - A sorokeep daemon pre-configured to talk to that local RPC
 *   - Separate named volumes to keep devnet data isolated from production
 *   - Verbose logging suitable for local development
 *
 * Acceptance criteria:
 *   "docker-compose up boots daemon and mock RPC environment successfully."
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEVNET_COMPOSE_FILE = path.join(ROOT, "docker-compose.devnet.yaml");
const BASE_COMPOSE_FILE = path.join(ROOT, "docker-compose.yaml");
const ENV_EXAMPLE_FILE = path.join(ROOT, ".env.example");

let devnetConfig: Record<string, any>;
let baseConfig: Record<string, any>;

beforeAll(() => {
    if (fs.existsSync(DEVNET_COMPOSE_FILE)) {
        const raw = fs.readFileSync(DEVNET_COMPOSE_FILE, "utf8");
        devnetConfig = YAML.parse(raw);
    }
    if (fs.existsSync(BASE_COMPOSE_FILE)) {
        const raw = fs.readFileSync(BASE_COMPOSE_FILE, "utf8");
        baseConfig = YAML.parse(raw);
    }
});

// ── File presence ─────────────────────────────────────────────────────────────

describe("docker-compose.devnet.yaml — file presence", () => {
    it("exists at the project root", () => {
        expect(fs.existsSync(DEVNET_COMPOSE_FILE)).toBe(true);
    });

    it("is valid YAML with a services section", () => {
        expect(devnetConfig).toBeDefined();
        expect(typeof devnetConfig).toBe("object");
        expect(devnetConfig.services).toBeDefined();
    });
});

// ── Stellar devnet service ────────────────────────────────────────────────────

describe("docker-compose.devnet.yaml — stellar service", () => {
    it("includes a stellar service", () => {
        expect(devnetConfig.services.stellar).toBeDefined();
    });

    it("uses the stellar/quickstart image (any tag)", () => {
        const image: string = devnetConfig.services.stellar.image;
        expect(image).toBeDefined();
        expect(image).toMatch(/^stellar\/quickstart/);
    });

    it("starts with --local flag (local sandbox mode)", () => {
        const command = devnetConfig.services.stellar.command;
        expect(command).toBeDefined();
        const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
        expect(cmdStr).toMatch(/--local/);
    });

    it("enables the Soroban RPC endpoint", () => {
        const command = devnetConfig.services.stellar.command;
        const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
        expect(cmdStr).toMatch(/--enable-soroban-rpc/);
    });

    it("exposes the Horizon / Soroban RPC port 8000", () => {
        const ports: string[] = (devnetConfig.services.stellar.ports ?? []).map(String);
        expect(ports.some((p: string) => p.includes("8000"))).toBe(true);
    });

    it("exposes the admin endpoint port 8001", () => {
        const ports: string[] = (devnetConfig.services.stellar.ports ?? []).map(String);
        expect(ports.some((p: string) => p.includes("8001"))).toBe(true);
    });

    it("declares a healthcheck targeting port 8000", () => {
        const healthcheck = devnetConfig.services.stellar.healthcheck;
        expect(healthcheck).toBeDefined();
        const testStr = Array.isArray(healthcheck.test)
            ? healthcheck.test.join(" ")
            : String(healthcheck.test);
        expect(testStr).toMatch(/8000/);
    });

    it("maps a named volume to /opt/stellar", () => {
        const volumes: string[] = (devnetConfig.services.stellar.volumes ?? []).map(String);
        expect(volumes.some((v: string) => v.includes("/opt/stellar"))).toBe(true);
    });

    it("belongs to a shared network", () => {
        const networks = devnetConfig.services.stellar.networks;
        expect(networks).toBeDefined();
        const networkList = Array.isArray(networks) ? networks : Object.keys(networks);
        expect(networkList.length).toBeGreaterThanOrEqual(1);
    });

    it("has a restart policy set", () => {
        const restart = devnetConfig.services.stellar.restart;
        expect(restart).toBeDefined();
        expect(typeof restart).toBe("string");
    });
});

// ── Sorokeep devnet service ───────────────────────────────────────────────────

describe("docker-compose.devnet.yaml — sorokeep service", () => {
    it("includes a sorokeep service", () => {
        expect(devnetConfig.services.sorokeep).toBeDefined();
    });

    it("depends on the stellar service being healthy", () => {
        const dependsOn = devnetConfig.services.sorokeep.depends_on;
        expect(dependsOn).toBeDefined();
        if (Array.isArray(dependsOn)) {
            expect(dependsOn).toContain("stellar");
        } else {
            expect(dependsOn.stellar).toBeDefined();
            expect(dependsOn.stellar.condition).toBe("service_healthy");
        }
    });

    it("sets SOROKEEP_NETWORK environment variable", () => {
        const env: string[] | Record<string, string> =
            devnetConfig.services.sorokeep.environment;
        expect(env).toBeDefined();
        const envKeys = Array.isArray(env)
            ? env.map((e: string) => e.split("=")[0])
            : Object.keys(env);
        expect(envKeys).toContain("SOROKEEP_NETWORK");
    });

    it("sets SOROKEEP_RPC_URL pointing to the local stellar service", () => {
        const env: string[] | Record<string, string> =
            devnetConfig.services.sorokeep.environment;
        const envEntries = Array.isArray(env)
            ? env.map((e: string) => e)
            : Object.entries(env).map(([k, v]) => `${k}=${v}`);
        const rpcEntry = envEntries.find((e: string) => e.startsWith("SOROKEEP_RPC_URL"));
        expect(rpcEntry).toBeDefined();
        // Must point at the stellar container on the bridge network, not an external URL
        expect(rpcEntry).toMatch(/stellar/);
        expect(rpcEntry).toMatch(/soroban\/rpc/);
    });

    it("sets SOROKEEP_POLLING_INTERVAL to a faster devnet cadence (< 60 000 ms)", () => {
        const env: string[] | Record<string, string> =
            devnetConfig.services.sorokeep.environment;
        const envEntries = Array.isArray(env)
            ? env.map((e: string) => e)
            : Object.entries(env).map(([k, v]) => `${k}=${v}`);
        const intervalEntry = envEntries.find((e: string) =>
            e.startsWith("SOROKEEP_POLLING_INTERVAL"),
        );
        expect(intervalEntry).toBeDefined();
        const intervalMs = parseInt(intervalEntry!.split("=")[1], 10);
        expect(intervalMs).toBeGreaterThanOrEqual(10000);
        expect(intervalMs).toBeLessThan(60000);
    });

    it("runs the daemon command with --network flag", () => {
        const command = devnetConfig.services.sorokeep.command;
        expect(command).toBeDefined();
        const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
        expect(cmdStr).toMatch(/daemon/);
        expect(cmdStr).toMatch(/--network/);
    });

    it("runs the daemon command with --rpc-url flag pointing at local stellar", () => {
        const command = devnetConfig.services.sorokeep.command;
        const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
        expect(cmdStr).toMatch(/--rpc-url/);
        expect(cmdStr).toMatch(/stellar/);
    });

    it("runs the daemon command with --interval flag", () => {
        const command = devnetConfig.services.sorokeep.command;
        const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
        expect(cmdStr).toMatch(/--interval/);
    });

    it("mounts a named volume at /home/sorokeep/.sorokeep", () => {
        const volumes: string[] = (devnetConfig.services.sorokeep.volumes ?? []).map(String);
        expect(volumes.some((v: string) => v.includes("/home/sorokeep/.sorokeep"))).toBe(true);
    });

    it("belongs to the same shared network as the stellar service", () => {
        const stellarNets = devnetConfig.services.stellar.networks;
        const sorokeepNets = devnetConfig.services.sorokeep.networks;

        const toList = (n: any): string[] =>
            Array.isArray(n) ? n : Object.keys(n);

        const stellarList = toList(stellarNets);
        const sorokeepList = toList(sorokeepNets);

        // At least one shared network
        const shared = stellarList.filter((n: string) => sorokeepList.includes(n));
        expect(shared.length).toBeGreaterThanOrEqual(1);
    });

    it("has a restart policy set", () => {
        const restart = devnetConfig.services.sorokeep.restart;
        expect(restart).toBeDefined();
        expect(typeof restart).toBe("string");
    });
});

// ── Volumes & Networks ────────────────────────────────────────────────────────

describe("docker-compose.devnet.yaml — volumes and networks", () => {
    it("declares named volumes for both stellar and sorokeep", () => {
        expect(devnetConfig.volumes).toBeDefined();
        const volumeNames = Object.keys(devnetConfig.volumes);
        expect(volumeNames.some((v: string) => v.toLowerCase().includes("stellar"))).toBe(true);
        expect(volumeNames.some((v: string) => v.toLowerCase().includes("sorokeep"))).toBe(true);
    });

    it("uses devnet-scoped volume names (different from base compose volumes)", () => {
        if (!baseConfig?.volumes) return;
        const devnetVols = Object.keys(devnetConfig.volumes);
        const baseVols = Object.keys(baseConfig.volumes);
        // At least one devnet volume should differ from base volumes
        const uniqueToDevnet = devnetVols.filter((v: string) => !baseVols.includes(v));
        expect(uniqueToDevnet.length).toBeGreaterThanOrEqual(1);
    });

    it("declares at least one network", () => {
        expect(devnetConfig.networks).toBeDefined();
        expect(Object.keys(devnetConfig.networks).length).toBeGreaterThanOrEqual(1);
    });
});

// ── .env.example ─────────────────────────────────────────────────────────────

describe(".env.example", () => {
    it("exists at the project root", () => {
        expect(fs.existsSync(ENV_EXAMPLE_FILE)).toBe(true);
    });

    it("documents SOROKEEP_NETWORK", () => {
        const content = fs.readFileSync(ENV_EXAMPLE_FILE, "utf8");
        expect(content).toMatch(/SOROKEEP_NETWORK/);
    });

    it("documents SOROKEEP_RPC_URL", () => {
        const content = fs.readFileSync(ENV_EXAMPLE_FILE, "utf8");
        expect(content).toMatch(/SOROKEEP_RPC_URL/);
    });

    it("documents SOROKEEP_POLLING_INTERVAL", () => {
        const content = fs.readFileSync(ENV_EXAMPLE_FILE, "utf8");
        expect(content).toMatch(/SOROKEEP_POLLING_INTERVAL/);
    });

    it("provides the local devnet RPC URL as the default example", () => {
        const content = fs.readFileSync(ENV_EXAMPLE_FILE, "utf8");
        expect(content).toMatch(/stellar.*soroban\/rpc/);
    });
});

// ── Compose compatibility (base + devnet can be merged) ───────────────────────

describe("base + devnet compose compatibility", () => {
    it("base compose has the same service names as the devnet overlay", () => {
        const baseServices = Object.keys(baseConfig.services);
        const devnetServices = Object.keys(devnetConfig.services);
        // Each service in the devnet overlay must exist in the base compose
        for (const svc of devnetServices) {
            expect(baseServices).toContain(svc);
        }
    });

    it("both compose files share at least one network name", () => {
        const baseNets = Object.keys(baseConfig.networks ?? {});
        const devnetNets = Object.keys(devnetConfig.networks ?? {});
        const shared = baseNets.filter((n: string) => devnetNets.includes(n));
        expect(shared.length).toBeGreaterThanOrEqual(1);
    });
});
