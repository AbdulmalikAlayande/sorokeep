import fs from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { exportDatabase, importDatabase, type DatabaseBackup } from "../db/backup.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "DbCommand" });

export function registerDbCommand(program: Command): void {
    const dbCommand = program
        .command("db")
        .description("Backup and restore database state");

    dbCommand
        .command("export")
        .description("Export tracked database tables as JSON to stdout")
        .action(() => {
            try {
                const db = getDatabase();
                const backup = exportDatabase(db);
                process.stdout.write(`${JSON.stringify(backup, null, 2)}\n`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Database export failed", { error: message });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    dbCommand
        .command("import <file>")
        .description("Import tracked database tables from a JSON backup file")
        .action((file: string) => {
            try {
                const db = getDatabase();
                const raw = fs.readFileSync(file, "utf-8");
                const backup = JSON.parse(raw) as DatabaseBackup;
                importDatabase(db, backup);
                console.log(chalk.green("Database import complete"));
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Database import failed", { error: message, file });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });
}
