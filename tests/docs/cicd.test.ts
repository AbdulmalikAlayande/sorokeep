import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("CI/CD integration guide", () => {
    const docPath = join(__dirname, "../../docs/CICD.md");

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
