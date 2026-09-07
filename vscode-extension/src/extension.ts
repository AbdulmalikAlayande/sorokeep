import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { openSorokeepDb, type DbReadMode } from "./dbReader.js";
import { TtlCodeLensProvider } from "./providers.js";

const DB_FILE_PATH_SETTING = "sorokeep.dbFilePath";
const DB_READ_MODE_SETTING = "sorokeep.dbReadMode";
const ENABLE_CODELENS_SETTING = "sorokeep.enableCodeLens";

function resolveDbFilePath(raw: string | undefined): string {
    const value = raw?.trim() || path.join(os.homedir(), ".sorokeep", "sorokeep.db");
    return value
        .replace("${HOME}", os.homedir())
        .replace(/^~(?=\/|\\)/, os.homedir());
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new TtlCodeLensProvider(() => {
        const config = vscode.workspace.getConfiguration("sorokeep");
        if (config.get<boolean>(ENABLE_CODELENS_SETTING, true) === false) return null;

        const readMode = config.get<DbReadMode>(DB_READ_MODE_SETTING, "readonly");
        const dbPath = resolveDbFilePath(config.get<string>(DB_FILE_PATH_SETTING));
        const db = openSorokeepDb(dbPath, { readMode });
        return db ? { db, close: () => db.close() } : null;
    });

    context.subscriptions.push(
        // Willing to run on any file type; the detector only reacts to
        // 56-char C-prefixed contract IDs so it stays inert elsewhere.
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),
    );
}

export function deactivate(): void {
    // No long-lived resources: the DB is opened per scan and closed there.
}