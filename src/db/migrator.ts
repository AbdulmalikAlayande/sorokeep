import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export class Migrator {
    private db: Database.Database;
    private migrationsDir: string;

    constructor(db: Database.Database, migrationsDir: string) {
        this.db = db;
        this.migrationsDir = migrationsDir;
    }

    /**
     * Initializes the migrations tracking table if it doesn't exist.
     */
    public init(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    /**
     * Retrieves all applied migration versions.
     */
    public getAppliedMigrations(): number[] {
        this.init();
        const rows = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC;").all() as { version: number }[];
        return rows.map((r) => r.version);
    }

    /**
     * Retrieves list of pending migrations from the migrations directory.
     */
    public getPendingMigrations(): { version: number; filename: string; filepath: string }[] {
        this.init();
        if (!fs.existsSync(this.migrationsDir)) {
            return [];
        }

        const files = fs.readdirSync(this.migrationsDir);
        const pending: { version: number; filename: string; filepath: string }[] = [];
        const applied = new Set(this.getAppliedMigrations());

        for (const file of files) {
            const match = file.match(/^(\d+)(?:_.*)?\.sql$/i);
            if (match) {
                const version = parseInt(match[1]!, 10);
                if (!applied.has(version)) {
                    pending.push({
                        version,
                        filename: file,
                        filepath: path.join(this.migrationsDir, file),
                    });
                }
            }
        }

        // Sort pending migrations by version to ensure sequential execution
        return pending.sort((a, b) => a.version - b.version);
    }

    /**
     * Executes all pending migrations sequentially.
     * Each migration script is executed in its own transaction.
     */
    public run(): void {
        this.init();
        const pending = this.getPendingMigrations();

        for (const migration of pending) {
            const sql = fs.readFileSync(migration.filepath, "utf-8");

            // Define transaction for the migration run
            const runMigrationTx = this.db.transaction(() => {
                this.db.exec(sql);
                this.db.prepare("INSERT INTO schema_migrations (version) VALUES (?);").run(migration.version);
            });

            // Execute migration transaction
            runMigrationTx();
        }
    }
}
