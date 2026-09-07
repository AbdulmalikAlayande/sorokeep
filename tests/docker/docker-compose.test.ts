import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");
const COMPOSE_FILE = path.join(ROOT, "docker-compose.yaml");
const OBSERVABILITY_COMPOSE_FILE = path.join(ROOT, "docker-compose.observability.yml");
const PROMETHEUS_CONFIG_FILE = path.join(ROOT, "devops/prometheus/prometheus.yml");
const GRAFANA_DASHBOARD_PROVIDER_FILE = path.join(
    ROOT,
    "devops/grafana/provisioning/dashboards/dashboard.yml",
);
const GRAFANA_DASHBOARD_FILE = path.join(ROOT, "devops/grafana/provisioning/dashboards/sorokeep-overview.json");

type ComposeScalar = string | number | boolean;
type ComposeList = ComposeScalar[];
type ComposeEnvironment = Record<string, ComposeScalar> | string[];

interface ComposeService {
    image?: string;
    command?: string | ComposeList;
    ports?: ComposeList;
    volumes?: ComposeList;
    healthcheck?: {
        test?: string | ComposeList;
    };
    build?: string | {
        context?: string;
        dockerfile?: string;
    };
    depends_on?: string[] | Record<string, {
        condition?: string;
    }>;
    environment?: ComposeEnvironment;
    profiles?: string[];
}

interface DockerComposeConfig {
    services: Record<string, ComposeService>;
    volumes?: Record<string, unknown>;
    networks?: Record<string, unknown>;
}

let composeConfig: DockerComposeConfig;
let observabilityComposeConfig: DockerComposeConfig;

beforeAll(() => {
    if (fs.existsSync(COMPOSE_FILE)) {
        const raw = fs.readFileSync(COMPOSE_FILE, "utf8");
        composeConfig = YAML.parse(raw) as DockerComposeConfig;
    }
    if (fs.existsSync(OBSERVABILITY_COMPOSE_FILE)) {
        observabilityComposeConfig = YAML.parse(fs.readFileSync(OBSERVABILITY_COMPOSE_FILE, "utf8")) as DockerComposeConfig;
    }
});

describe("docker-compose.yaml configuration", () => {
    it("exists at the root directory", () => {
        expect(fs.existsSync(COMPOSE_FILE)).toBe(true);
    });

    it("is valid YAML", () => {
        expect(composeConfig).toBeDefined();
        expect(typeof composeConfig).toBe("object");
        expect(composeConfig.services).toBeDefined();
    });

    describe("stellar service", () => {
        it("exists in services", () => {
            expect(composeConfig.services.stellar).toBeDefined();
        });

        it("uses the official stellar/quickstart image", () => {
            const image = composeConfig.services.stellar.image;
            expect(image).toBeDefined();
            expect(image).toMatch(/^stellar\/quickstart/);
        });

        it("uses local sandbox devnet mode with soroban-rpc enabled", () => {
            const command = composeConfig.services.stellar.command;
            expect(command).toBeDefined();
            const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
            expect(cmdStr).toMatch(/--local/);
            expect(cmdStr).toMatch(/--enable-soroban-rpc/);
        });

        it("exposes ports 8000 and 8001", () => {
            const ports = composeConfig.services.stellar.ports;
            expect(ports).toBeDefined();
            expect(Array.isArray(ports)).toBe(true);
            const portList = ports.map(String);
            expect(portList.some((p: string) => p.includes("8000"))).toBe(true);
            expect(portList.some((p: string) => p.includes("8001"))).toBe(true);
        });

        it("declares a persistence volume mapping to /opt/stellar", () => {
            const volumes = composeConfig.services.stellar.volumes;
            expect(volumes).toBeDefined();
            expect(Array.isArray(volumes)).toBe(true);
            const volList = volumes.map(String);
            expect(volList.some((v: string) => v.includes("/opt/stellar"))).toBe(true);
        });

        it("configures a healthcheck checking port 8000", () => {
            const healthcheck = composeConfig.services.stellar.healthcheck;
            expect(healthcheck).toBeDefined();
            expect(healthcheck.test).toBeDefined();
            const testStr = Array.isArray(healthcheck.test) ? healthcheck.test.join(" ") : String(healthcheck.test);
            expect(testStr).toMatch(/8000/);
        });
    });

    describe("sorokeep service", () => {
        it("exists in services", () => {
            expect(composeConfig.services.sorokeep).toBeDefined();
        });

        it("builds from the local project context", () => {
            const build = composeConfig.services.sorokeep.build;
            expect(build).toBeDefined();
            if (typeof build === "object") {
                expect(build.context).toBe(".");
                expect(build.dockerfile).toBe("Dockerfile");
            } else {
                expect(build).toBe(".");
            }
        });

        it("depends on the stellar service to be healthy", () => {
            const dependsOn = composeConfig.services.sorokeep.depends_on;
            expect(dependsOn).toBeDefined();
            if (Array.isArray(dependsOn)) {
                expect(dependsOn).toContain("stellar");
            } else {
                expect(dependsOn.stellar).toBeDefined();
                expect(dependsOn.stellar.condition).toBe("service_healthy");
            }
        });

        it("maps environment configurations", () => {
            const env = composeConfig.services.sorokeep.environment;
            expect(env).toBeDefined();
            const envKeys = Array.isArray(env) 
                ? env.map((e: string) => e.split("=")[0]) 
                : Object.keys(env);
            expect(envKeys).toContain("SOROKEEP_NETWORK");
            expect(envKeys).toContain("SOROKEEP_RPC_URL");
            expect(envKeys).toContain("SOROKEEP_POLLING_INTERVAL");
        });

        it("runs the daemon command with correct arguments", () => {
            const command = composeConfig.services.sorokeep.command;
            expect(command).toBeDefined();
            const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
            expect(cmdStr).toMatch(/daemon/);
            expect(cmdStr).toMatch(/--network/);
            expect(cmdStr).toMatch(/--rpc-url/);
            expect(cmdStr).toMatch(/--interval/);
        });

        it("declares a persistence volume mapping to /home/sorokeep/.sorokeep", () => {
            const volumes = composeConfig.services.sorokeep.volumes;
            expect(volumes).toBeDefined();
            expect(Array.isArray(volumes)).toBe(true);
            const volList = volumes.map(String);
            expect(volList.some((v: string) => v.includes("/home/sorokeep/.sorokeep"))).toBe(true);
        });
    });

    describe("volumes and networks", () => {
        it("declares named volumes for stellar and sorokeep", () => {
            expect(composeConfig.volumes).toBeDefined();
            const volumes = Object.keys(composeConfig.volumes);
            expect(volumes.some((v: string) => v.includes("stellar"))).toBe(true);
            expect(volumes.some((v: string) => v.includes("sorokeep"))).toBe(true);
        });

        it("declares a shared network", () => {
            expect(composeConfig.networks).toBeDefined();
            const networks = Object.keys(composeConfig.networks);
            expect(networks.length).toBeGreaterThanOrEqual(1);
        });
    });
});

describe("observability compose overlay", () => {
    it("defines profiled Prometheus and Grafana services", () => {
        expect(fs.existsSync(OBSERVABILITY_COMPOSE_FILE)).toBe(true);
        expect(observabilityComposeConfig.services.prometheus.profiles).toContain("observability");
        expect(observabilityComposeConfig.services.grafana.profiles).toContain("observability");
    });

    it("wires Prometheus to Sorokeep's metrics endpoint", () => {
        expect(fs.existsSync(PROMETHEUS_CONFIG_FILE)).toBe(true);
        const prometheusConfig = YAML.parse(fs.readFileSync(PROMETHEUS_CONFIG_FILE, "utf8"));
        const targets = prometheusConfig.scrape_configs.flatMap((job: any) =>
            job.static_configs.flatMap((config: any) => config.targets),
        );
        expect(targets).toContain("sorokeep:9464");
    });

    it("provisions the Sorokeep Grafana dashboard", () => {
        expect(fs.existsSync(GRAFANA_DASHBOARD_PROVIDER_FILE)).toBe(true);
        expect(fs.existsSync(GRAFANA_DASHBOARD_FILE)).toBe(true);
        const dashboard = JSON.parse(fs.readFileSync(GRAFANA_DASHBOARD_FILE, "utf8"));
        expect(dashboard.title).toBe("Sorokeep Overview");
        expect(dashboard.panels.length).toBeGreaterThan(0);
    });
});
