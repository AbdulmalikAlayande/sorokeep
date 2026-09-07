import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
    class Position {
        constructor(public line: number, public character: number) {}
    }
    class Range {
        constructor(public start: Position, public end: Position) {}
        static from(obj: { start: { line: number; character: number }; end: { line: number; character: number } }) {
            return new Range(new Position(obj.start.line, obj.start.character), new Position(obj.end.line, obj.end.character));
        }
    }
    class CodeLens {
        constructor(public range: Range, public command?: unknown) {}
    }
    return {
        Position,
        Range,
        CodeLens,
        CodeLensProvider: class {},
        window: {},
        workspace: { getConfiguration: () => ({}) },
    };
});

import {
    createFixtureDb,
    TRACKED_CONTRACT_ID,
    UNTRACKED_CONTRACT_ID,
} from "./helpers/fixture.js";
import { TtlCodeLensProvider } from "../src/providers.js";
import * as vscode from "vscode";

function makeProvider(): { provider: TtlCodeLensProvider; db: any } {
    const db = createFixtureDb();
    db.prepare(
        `INSERT INTO contracts (id, name, network, last_checked_ledger) VALUES (?, ?, 'testnet', ?)`,
    ).run(TRACKED_CONTRACT_ID, "USD Stablecoin Gateway", 2_400_000);
    db.prepare(
        `INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, label, live_until_ledger) VALUES (?, ?, 'instance', 'Contract Instance', ?)`,
    ).run(TRACKED_CONTRACT_ID, "AAAAinstance", 2_401_000);
    const provider = new TtlCodeLensProvider(() => ({
        db,
        close: () => {},
    }));
    return { provider, db };
}

function textDoc(content: string): vscode.TextDocument {
    const lines = content.split("\n");
    return {
        getText(): string {
            return content;
        },
        lineAt(line: number): { text: string } {
            return { text: lines[line] ?? "" };
        },
        positionAt(offset: number): vscode.Position {
            let cursor = 0;
            for (let line = 0; line < lines.length; line++) {
                if (offset <= cursor + lines[line]!.length) {
                    return new vscode.Position(line, offset - cursor);
                }
                cursor += lines[line]!.length + 1;
            }
            return new vscode.Position(lines.length, 0);
        },
    } as unknown as vscode.TextDocument;
}

describe("TtlCodeLensProvider.provideCodeLenses (acceptance criteria)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("shows a CodeLens with the correct TTL status for a watched contract ID", () => {
        const { provider } = makeProvider();
        // live 2,401,000 - checked 2,400,000 = 1,000 → critical
        const doc = textDoc(`const c = "${TRACKED_CONTRACT_ID}";`);
        const lenses = provider.provideCodeLenses(doc as unknown as vscode.TextDocument);
        expect(lenses).toHaveLength(1);
        const label = JSON.stringify(lenses![0]!.command?.title ?? "");
        expect(label).toMatch(/CRITICAL/i);
    });

    it("shows no CodeLens for a contract ID sorokeep does not track (no false positives)", () => {
        const { provider } = makeProvider();
        const doc = textDoc(`const c2 = "${UNTRACKED_CONTRACT_ID}";`);
        expect(provider.provideCodeLenses(doc as unknown as vscode.TextDocument)).toHaveLength(0);
    });

    it("shows no CodeLens for documents with no contract IDs", () => {
        const { provider } = makeProvider();
        const doc = textDoc("const x = 42; // nothing");
        expect(provider.provideCodeLenses(doc as unknown as vscode.TextDocument)).toHaveLength(0);
    });
});