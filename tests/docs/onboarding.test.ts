import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
const ADR_DIR = path.join(DOCS_DIR, "adr");

function readFile(p: string): string {
    return fs.readFileSync(p, "utf-8");
}

function fileExists(p: string): boolean {
    return fs.existsSync(p);
}

// ─── Required Files Exist ─────────────────────────────────────────────────────

describe("Onboarding documentation completeness", () => {
    it("CONTRIBUTING.md exists at repository root", () => {
        expect(fileExists(path.join(PROJECT_ROOT, "CONTRIBUTING.md"))).toBe(true);
    });

    it("README.md exists at repository root", () => {
        expect(fileExists(path.join(PROJECT_ROOT, "README.md"))).toBe(true);
    });

    it("docs/ directory exists", () => {
        expect(fileExists(DOCS_DIR)).toBe(true);
    });

    it("docs/adr/ directory exists", () => {
        expect(fileExists(ADR_DIR)).toBe(true);
    });

    it("docs/e2e-sandbox.md exists", () => {
        expect(fileExists(path.join(DOCS_DIR, "e2e-sandbox.md"))).toBe(true);
    });

    it("all 6 ADR files exist", () => {
        const expectedAdrs = [
            "ADR-001-use-sqlite-for-local-storage.md",
            "ADR-002-use-esm-modules.md",
            "ADR-003-use-commander-js-for-cli.md",
            "ADR-004-polling-daemon-architecture.md",
            "ADR-005-use-typescript-over-rust.md",
            "ADR-006-in-memory-sqlite-for-testing.md",
        ];
        for (const adr of expectedAdrs) {
            expect(fileExists(path.join(ADR_DIR, adr))).toBe(true);
        }
    });
});

// ─── CONTRIBUTING.md Content Validation ───────────────────────────────────────

describe("CONTRIBUTING.md content and references", () => {
    const contributing = readFile(path.join(PROJECT_ROOT, "CONTRIBUTING.md"));

    it("contains a table of contents", () => {
        expect(contributing).toContain("## Table of Contents");
    });

    it("contains quick start section", () => {
        expect(contributing).toContain("## Quick Start");
    });

    it("contains project structure section", () => {
        expect(contributing).toContain("## Project Structure");
    });

    it("contains development workflow section", () => {
        expect(contributing).toContain("## Development Workflow");
    });

    it("mentions test-driven development", () => {
        expect(contributing).toContain("Test-Driven Development");
    });

    it("mentions running tests", () => {
        expect(contributing).toContain("npm test");
        expect(contributing).toContain("vitest run");
    });

    it("mentions linting and type checking", () => {
        expect(contributing).toContain("npm run lint");
        expect(contributing).toContain("tsc --noEmit");
    });

    it("contains code conventions section", () => {
        expect(contributing).toContain("## Code Conventions");
    });

    it("mentions conventional commit format", () => {
        expect(contributing).toContain("conventional commit");
        expect(contributing).toContain("feat:");
        expect(contributing).toContain("fix:");
    });

    it("contains architecture decision records section", () => {
        expect(contributing).toContain("## Architecture Decision Records");
    });

    it("references each ADR file from CONTRIBUTING.md", () => {
        const expectedAdrRefs = [
            "ADR-001",
            "ADR-002",
            "ADR-003",
            "ADR-004",
            "ADR-005",
            "ADR-006",
        ];
        for (const ref of expectedAdrRefs) {
            expect(contributing).toContain(ref);
        }
    });

    it("references the E2E sandbox guide", () => {
        expect(contributing).toContain("e2e-sandbox.md");
    });

    it("contains PR checklist section", () => {
        expect(contributing).toContain("## PR Checklist");
    });

    it("contains getting help section", () => {
        expect(contributing).toContain("## Getting Help");
    });
});

// ─── ADR Content Validation ───────────────────────────────────────────────────

describe("ADR files are well-formed", () => {
    const adrFiles = fs.readdirSync(ADR_DIR).filter(f => f.endsWith(".md")).sort();

    it("all ADRs have a status header", () => {
        for (const file of adrFiles) {
            const content = readFile(path.join(ADR_DIR, file));
            expect(content).toMatch(/\*\*Status:\*\*/);
        }
    });

    it("all ADRs have a date header", () => {
        for (const file of adrFiles) {
            const content = readFile(path.join(ADR_DIR, file));
            expect(content).toMatch(/\*\*Date:\*\*/);
        }
    });

    it("all ADRs have a context section", () => {
        for (const file of adrFiles) {
            const content = readFile(path.join(ADR_DIR, file));
            expect(content).toMatch(/## Context/);
        }
    });

    it("all ADRs have a decision outcome section", () => {
        for (const file of adrFiles) {
            const content = readFile(path.join(ADR_DIR, file));
            expect(content).toMatch(/## Decision Outcome/);
        }
    });

    it("all ADRs have a consequences section or validation section", () => {
        for (const file of adrFiles) {
            const content = readFile(path.join(ADR_DIR, file));
            const hasConsequences = content.includes("### Consequences");
            const hasValidation = content.includes("## Validation");
            expect(hasConsequences || hasValidation).toBe(true);
        }
    });

    it("ADR-001 explains SQLite choice", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-001-use-sqlite-for-local-storage.md"));
        expect(adr).toContain("SQLite");
        expect(adr).toContain("better-sqlite3");
        expect(adr).toContain("Context");
        expect(adr).toContain("Decision Outcome");
    });

    it("ADR-002 explains ESM choice", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-002-use-esm-modules.md"));
        expect(adr).toContain("ESM");
        expect(adr).toContain("ECMAScript Modules");
        expect(adr).toContain("\"type\": \"module\"");
    });

    it("ADR-003 explains Commander.js choice", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-003-use-commander-js-for-cli.md"));
        expect(adr).toContain("Commander.js");
        expect(adr).toContain("oclif");
    });

    it("ADR-004 explains polling architecture", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-004-polling-daemon-architecture.md"));
        expect(adr).toContain("Polling");
        expect(adr).toContain("WebSocket");
        expect(adr).toContain("RPC");
    });

    it("ADR-005 explains TypeScript choice over Rust", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-005-use-typescript-over-rust.md"));
        expect(adr).toContain("TypeScript");
        expect(adr).toContain("Rust");
    });

    it("ADR-006 explains in-memory SQLite for testing", () => {
        const adr = readFile(path.join(ADR_DIR, "ADR-006-in-memory-sqlite-for-testing.md"));
        expect(adr).toContain("In-Memory");
        expect(adr).toContain("getDatabaseForTesting");
    });
});

// ─── E2E Sandbox Guide Validation ─────────────────────────────────────────────

describe("E2E sandbox guide", () => {
    const sandbox = readFile(path.join(DOCS_DIR, "e2e-sandbox.md"));

    it("contains prerequisites section", () => {
        expect(sandbox).toContain("## Prerequisites");
    });

    it("contains local network setup instructions", () => {
        expect(sandbox).toContain("stellar/quickstart");
    });

    it("contains test account setup instructions", () => {
        expect(sandbox).toContain("stellar keys generate");
    });

    it("contains contract deployment instructions", () => {
        expect(sandbox).toContain("stellar contract deploy");
    });

    it("contains Sorokeep watch configuration", () => {
        expect(sandbox).toContain("src/index.ts watch");
    });

    it("contains daemon run instructions", () => {
        expect(sandbox).toContain("sorokeep daemon");
    });

    it("contains troubleshooting section", () => {
        expect(sandbox).toContain("## Troubleshooting");
    });

    it("contains verification checklist", () => {
        expect(sandbox).toContain("Verification Checklist");
    });

    it("mentions all major Sorokeep commands", () => {
        expect(sandbox).toContain("src/index.ts watch");
        expect(sandbox).toContain("src/index.ts status");
        expect(sandbox).toContain("src/index.ts daemon");
        expect(sandbox).toContain("sorokeep guard");
        expect(sandbox).toContain("sorokeep alerts");
    });

    it("covers automated E2E test script option", () => {
        expect(sandbox).toContain("Automated E2E Test Script");
    });

    it("covers testnet sandbox option", () => {
        expect(sandbox).toContain("Testnet Sandbox");
    });
});

// ─── Cross-Reference Validation ───────────────────────────────────────────────

describe("Cross-reference validation", () => {
    it("all ADR links in CONTRIBUTING.md resolve to existing files", () => {
        const contributing = readFile(path.join(PROJECT_ROOT, "CONTRIBUTING.md"));
        const linkRegex = /\(docs\/adr\/[^)]+\.md\)/g;
        const links = contributing.match(linkRegex) || [];
        for (const link of links) {
            const filePath = link.slice(1, -1); // remove parens
            const absPath = path.join(PROJECT_ROOT, filePath);
            expect(fileExists(absPath)).toBe(true);
        }
    });

    it("README.md link to CONTRIBUTING.md is valid", () => {
        const readme = readFile(path.join(PROJECT_ROOT, "README.md"));
        expect(readme).toContain("CONTRIBUTING.md");
    });

    it("all section anchors in CONTRIBUTING.md match section headers", () => {
        const contributing = readFile(path.join(PROJECT_ROOT, "CONTRIBUTING.md"));
        // Extract header anchors: rendered as [text](#anchor)
        const anchorRegex = /\(#([^)]+)\)/g;
        const anchors: string[] = [];
        let match;
        while ((match = anchorRegex.exec(contributing)) !== null) {
            anchors.push(match[1]);
        }
        // Extract all section headers (## or ###)
        const headerRegex = /^#{2,3}\s+(.+)$/gm;
        const headers: string[] = [];
        while ((match = headerRegex.exec(contributing)) !== null) {
            const slug = match[1]
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
            headers.push(slug);
        }
        // Check each anchor has a matching header
        for (const anchor of anchors) {
            if (!anchor.startsWith("user-content-")) {
                expect(headers).toContain(anchor);
            }
        }
    });
});
