import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { getDatabase, vacuumDatabase } from "../db/database.js";
import { Migrator } from "../db/migrator.js";
import { exportDatabase, importDatabase, type DatabaseBackup } from "../db/backup.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "DbCommand" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../db/migrations");

export function registerDbCommand(program: Command): void {
    const dbCommand = program
        .command("db")
        .description("Backup, restore, and maintain database state");

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

    dbCommand
        .command("status")
        .description("Show status of database migrations")
        .action(() => {
            try {
                const db = getDatabase();
                const migrator = new Migrator(db, migrationsDir);
                const applied = migrator.getAppliedMigrations();
                const pending = migrator.getPendingMigrations();

                console.log(chalk.bold("Applied Migrations:"));
                if (applied.length === 0) {
                    console.log("  No migrations applied yet.");
                } else {
                    applied.forEach((version) => {
                        console.log(`  - Version ${version}`);
                    });
                }

                console.log();
                console.log(chalk.bold("Pending Migrations:"));
                if (pending.length === 0) {
                    console.log("  No pending migrations.");
                } else {
                    pending.forEach((p) => {
                        console.log(`  - Version ${p.version} (${p.filename})`);
                    });
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Database status failed", { error: message });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    dbCommand
        .command("migrate")
        .description("Run all pending database migrations")
        .action(() => {
            try {
                const db = getDatabase();
                const migrator = new Migrator(db, migrationsDir);
                const pending = migrator.getPendingMigrations();

                if (pending.length === 0) {
                    console.log("No pending migrations. Database is up to date.");
                } else {
                    console.log(`Running ${pending.length} pending migration(s)...`);
                    migrator.run();
                    console.log(chalk.green("Migrations applied successfully."));
                }

                const applied = migrator.getAppliedMigrations();
                console.log(chalk.bold("Applied Migrations:"));
                applied.forEach((version) => {
                    console.log(`  - Version ${version}`);
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Database migration failed", { error: message });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    dbCommand
        .command("vacuum")
        .description("Run VACUUM to reclaim space and optimize the database")
        .action(() => {
            try {
                const db = getDatabase();
                const success = vacuumDatabase(db);
                if (success) {
                    console.log(chalk.green("Database vacuum completed successfully."));
                } else {
                    logger.error("Database vacuum failed or was skipped because of an active transaction or lock");
                    console.error(chalk.red("Error: Database vacuum failed or was skipped because of an active transaction or lock."));
                    process.exit(1);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error("Database vacuum failed with exception", { error: message });
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });
}

