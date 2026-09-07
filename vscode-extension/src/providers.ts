import * as vscode from "vscode";
import { extractContractIds } from "./contractId.js";
import { readContractStatus, type SorokeepDbFactory } from "./dbReader.js";
import { renderCodeLensForStatus } from "./lensModel.js";

/**
 * CodeLensProvider that finds Stellar contract IDs in the open document and,
 * for the ones sorokeep tracks, renders an inline TTL/expiry status above them.
 *
 * The database factory is injected so the provider is trivially unit-testable
 * against a fixture database (see tests/providers.test.ts). The provider opens,
 * reads, and closes the DB per document scan and never writes.
 */
export class TtlCodeLensProvider implements vscode.CodeLensProvider {
    constructor(private readonly dbFactory: SorokeepDbFactory) {}

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const text = document.getText();
        const matches = extractContractIds(text);
        if (matches.length === 0) return [];

        const handle = this.dbFactory();
        if (!handle) return [];

        try {
            const lenses: vscode.CodeLens[] = [];
            for (const match of matches) {
                const status = readContractStatus(handle.db, match.contractId);
                if (!status) continue; // untracked contract → no lens

                const rendered = renderCodeLensForStatus(status);
                if (!rendered) continue; // tracked but unknown TTL → no speculative lens

                const range = new vscode.Range(
                    document.positionAt(match.start),
                    document.positionAt(match.end),
                );
                // No-op command id so the lens is pure inline status (no click
                // action), while `title` carries the rendered TTL status.
                lenses.push(
                    new vscode.CodeLens(range, {
                        command: "",
                        title: rendered.label,
                    }),
                );
            }
            return lenses;
        } finally {
            handle.close();
        }
    }
}