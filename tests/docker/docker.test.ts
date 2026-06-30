import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERIGNORE = path.join(ROOT, ".dockerignore");

let dockerfile: string;
let dockerignore: string;

beforeAll(() => {
    dockerfile = fs.existsSync(DOCKERFILE) ? fs.readFileSync(DOCKERFILE, "utf8") : "";
    dockerignore = fs.existsSync(DOCKERIGNORE) ? fs.readFileSync(DOCKERIGNORE, "utf8") : "";
});

describe("Dockerfile", () => {
    it("exists", () => {
        expect(fs.existsSync(DOCKERFILE)).toBe(true);
    });

    it("uses a multi-stage build", () => {
        const fromLines = dockerfile.match(/^FROM\s+/gim) ?? [];
        expect(fromLines.length).toBeGreaterThanOrEqual(2);
    });

    it("uses Node 22 as the base image", () => {
        expect(dockerfile).toMatch(/FROM\s+node:22/i);
    });

    it("runs as a non-root user", () => {
        expect(dockerfile).toMatch(/USER\s+(?!root)\S+/i);
    });

    it("declares a VOLUME for the database directory", () => {
        expect(dockerfile).toMatch(/VOLUME\s+/i);
        // volume should reference the sorokeep data directory
        expect(dockerfile).toMatch(/sorokeep/i);
    });

    it("exposes port 3000 for the future dashboard", () => {
        expect(dockerfile).toMatch(/EXPOSE\s+3000/);
    });

    it("sets NODE_ENV to production", () => {
        expect(dockerfile).toMatch(/NODE_ENV\s*[=\s]\s*production/);
    });

    it("copies only production artefacts into the final stage", () => {
        // Final stage must not copy devDependencies; package install should use --omit=dev or npm ci --omit=dev
        expect(dockerfile).toMatch(/--omit=dev|npm\s+ci\s+--production|npm\s+install\s+--production/i);
    });

    it("sets the correct ENTRYPOINT or CMD to the CLI binary", () => {
        expect(dockerfile).toMatch(/ENTRYPOINT\s+|CMD\s+/i);
        expect(dockerfile).toMatch(/sorokeep|dist\/index\.js/i);
    });
});

describe(".dockerignore", () => {
    it("exists", () => {
        expect(fs.existsSync(DOCKERIGNORE)).toBe(true);
    });

    it("excludes node_modules", () => {
        expect(dockerignore).toMatch(/node_modules/);
    });

    it("excludes the dist build output (built inside Docker)", () => {
        expect(dockerignore).toMatch(/dist/);
    });

    it("excludes test files", () => {
        expect(dockerignore).toMatch(/tests/);
    });

    it("excludes .git directory", () => {
        expect(dockerignore).toMatch(/\.git/);
    });
});
