import type Database from "better-sqlite3";

const EXPORT_TABLES = [
    "contracts",
    "contract_entries",
    "extension_policies",
    "alert_configs",
    "channel_accounts",
    "resource_alert_configs",
] as const;

const CLEAR_TABLES = [
    "resource_alert_configs",
    "alert_configs",
    "extension_policies",
    "channel_accounts",
    "contract_entries",
    "contracts",
] as const;

const TABLE_COLUMNS: Record<(typeof EXPORT_TABLES)[number], readonly string[]> = {
    contracts: [
        "id",
        "name",
        "network",
        "wasm_hash",
        "tags",
        "registered_at",
        "last_checked_ledger",
        "last_introspected_at",
    ],
    contract_entries: [
        "id",
        "contract_id",
        "entry_key_xdr",
        "entry_type",
        "label",
        "live_until_ledger",
        "last_modified_ledger",
        "discovery_source",
        "first_seen_at",
        "last_checked_at",
    ],
    extension_policies: [
        "id",
        "contract_id",
        "enabled",
        "target_ttl_ledgers",
        "extend_when_below_ledgers",
        "keypair_public",
        "keypair_source",
        "created_at",
    ],
    alert_configs: [
        "id",
        "contract_id",
        "channel_type",
        "channel_target",
        "threshold_ledgers",
        "webhook_secret",
        "created_at",
    ],
    channel_accounts: [
        "id",
        "public_key",
        "keypair_source",
        "label",
        "network",
        "funded",
        "balance_xlm",
        "balance_checked_at",
        "created_at",
    ],
    resource_alert_configs: [
        "id",
        "contract_id",
        "channel_type",
        "channel_target",
        "cpu_limit",
        "mem_limit",
        "webhook_secret",
        "created_at",
    ],
};

export interface DatabaseBackup {
    contracts: Record<string, unknown>[];
    contract_entries: Record<string, unknown>[];
    extension_policies: Record<string, unknown>[];
    alert_configs: Record<string, unknown>[];
    channel_accounts: Record<string, unknown>[];
    resource_alert_configs: Record<string, unknown>[];
}

export function exportDatabase(db: Database.Database): DatabaseBackup {
    return {
        contracts: selectTable(db, "contracts"),
        contract_entries: selectTable(db, "contract_entries"),
        extension_policies: selectTable(db, "extension_policies"),
        alert_configs: selectTable(db, "alert_configs"),
        channel_accounts: selectTable(db, "channel_accounts"),
        resource_alert_configs: selectTable(db, "resource_alert_configs"),
    };
}

export function importDatabase(db: Database.Database, backup: DatabaseBackup): void {
    validateBackup(backup);

    const transaction = db.transaction((payload: DatabaseBackup) => {
        for (const table of CLEAR_TABLES) {
            db.prepare(`DELETE FROM ${table}`).run();
        }

        for (const table of EXPORT_TABLES) {
            const rows = payload[table];
            if (rows.length === 0) {
                continue;
            }

            const columns = TABLE_COLUMNS[table];
            const placeholders = columns.map((column) => `@${column}`).join(", ");
            const insert = db.prepare(
                `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
            );

            for (const row of rows) {
                insert.run(normalizeRow(row, columns));
            }
        }
    });

    transaction(backup);
}

function selectTable(db: Database.Database, table: (typeof EXPORT_TABLES)[number]): Record<string, unknown>[] {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all() as Record<string, unknown>[];
}

function validateBackup(value: unknown): asserts value is DatabaseBackup {
    if (!value || typeof value !== "object") {
        throw new Error("Invalid database backup: expected an object");
    }

    for (const table of EXPORT_TABLES) {
        if (!Array.isArray((value as Record<string, unknown>)[table])) {
            throw new Error(`Invalid database backup: missing table '${table}'`);
        }
    }
}

function normalizeRow(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const column of columns) {
        normalized[column] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
    }
    return normalized;
}
