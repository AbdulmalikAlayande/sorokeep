import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "yaml";

describe("Release Workflow Config", () => {
    it("has provenance enabled in publish-npm job", () => {
        const workflowPath = join(process.cwd(), ".github/workflows/release.yml");
        expect(existsSync(workflowPath)).toBe(true);

        const fileContent = readFileSync(workflowPath, "utf8");
        const parsedYaml = yaml.parse(fileContent);

        const publishNpmJob = parsedYaml.jobs["publish-npm"];
        expect(publishNpmJob).toBeDefined();

        // Should have id-token: write permission
        expect(publishNpmJob.permissions).toBeDefined();
        expect(publishNpmJob.permissions["id-token"]).toBe("write");

        // Should have npm publish --provenance
        const steps = publishNpmJob.steps;
        const publishStep = steps.find((step: any) => step.run && step.run.includes("npm publish"));
        expect(publishStep).toBeDefined();
        expect(publishStep.run).toContain("--provenance");
    });
});

describe("Provenance Documentation", () => {
    it("documents how to verify provenance in README.md or CONTRIBUTING.md", () => {
        const readmePath = join(process.cwd(), "README.md");
        const contributingPath = join(process.cwd(), "CONTRIBUTING.md");

        const hasReadmeDocs = existsSync(readmePath) && readFileSync(readmePath, "utf8").includes("npm audit signatures");
        const hasContributingDocs = existsSync(contributingPath) && readFileSync(contributingPath, "utf8").includes("npm audit signatures");

        expect(hasReadmeDocs || hasContributingDocs).toBe(true);
    });
});
