import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("CI/CD integration guide", () => {
    const docPath = join(__dirname, "../../docs/CICD.md");
    const examplePath = join(__dirname, "../../.github/workflows/examples/predeploy-ttl-extension.yml");

    it("docs/CICD.md exists and is non-empty", () => {
        const content = readFileSync(docPath, "utf8");
        expect(content.length).toBeGreaterThan(200);
    });

    it("contains a GitHub Actions section with a YAML example", () => {
        const content = readFileSync(docPath, "utf8");
        expect(content).toMatch(/GitHub Actions/i);
        expect(content).toMatch(/```yaml/);
        expect(content).toMatch(/npx sorokeep/i);
    });

    it("links to a pre-deploy TTL extension example and documents the required secrets", () => {
        const content = readFileSync(docPath, "utf8");
        expect(content).toMatch(/pre-deploy TTL extension|predeploy-ttl-extension/i);
        expect(content).toMatch(/STELLAR_RPC_URL/i);
        expect(content).toMatch(/MAINNET_EXTENSION_KEY|extension key/i);
        expect(content).toMatch(/environment|protected.*secret|scoped.*secret/i);
    });

    it("includes a one-time guard extension example before deployment", () => {
        const content = readFileSync(examplePath, "utf8");
        expect(content).toMatch(/sorokeep guard/);
        expect(content).toMatch(/--keypair-env STELLAR_SECRET_KEY/i);
        expect(content).toMatch(/--target-ttl 100000/i);
        expect(content).toMatch(/--threshold 20000/i);
        expect(content).not.toMatch(/--auto-extend/i);
    });

    it("contains a GitLab CI section with a YAML example", () => {
        const content = readFileSync(docPath, "utf8");
        expect(content).toMatch(/GitLab CI/i);
        expect(content).toMatch(/```yaml/);
        expect(content).toMatch(/npx sorokeep/i);
    });

    it("contains a Bitbucket Pipelines section with a YAML example", () => {
        const content = readFileSync(docPath, "utf8");
        expect(content).toMatch(/Bitbucket Pipelines/i);
        expect(content).toMatch(/```yaml/);
        expect(content).toMatch(/npx sorokeep/i);
    });
});
