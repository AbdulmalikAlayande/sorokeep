import type Database from "better-sqlite3";

export interface Contract {
    id: string;
    name: string | null;
    network: string;
    wasm_hash: string | null;
    tags: string | null;
    registered_at: Date;
    last_checked_ledger?: number | null;
}

export interface ContractEntry {
    id: number;
    contract_id: string;
    entry_key_xdr: string;
    entry_type: "instance" | "wasm" | "persistent" | "temporary";
    label: string | null;
    live_until_ledger: number;
    last_modified_ledger: number;
    discovery_source: "deterministic" | "manual" | "instance_scan" | "footprint";
    first_seen_at: Date;
    last_checked_at: Date | null;
}

export interface ExtensionPolicy {
    id: number;
    contract_id: string;
    enabled: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public: string | null;
    keypair_source: string | null;
    created_at: Date;
}

export interface AlertConfig {
    id: number;
    contract_id: string;
    channel_type: "slack" | "webhook";
    channel_target: string;
    threshold_ledgers: number;
    webhook_secret: string | null;
    created_at: Date;
}

export interface AlertFired {
    id: number;
    alert_config_id: number;
    contract_entry_id: number;
    fired_at_ledger: number;
    fired_at: Date;
    ttl_at_fire: number;
    resolved: boolean;
    resolved_at?: string | null;
}

export interface ExtensionRecord {
    id: number;
    contract_id: string;
    contract_entry_id: number;
    old_ttl_ledgers: number;
    new_ttl_ledgers: number;
    tx_hash: string;
    cost_xlm: number | null;
    executed_at_ledger: number;
    executed_at: string;
}

// ---------------------------- Database Access Functions For Schema: Contract ----------------------------
export function insertContract(db: Database.Database, contract: {id: string; name?: string; network: string; wasm_hash?: string; tags?: string;}): void {
    db.prepare(`
        INSERT INTO contracts (id, name, network, wasm_hash, tags)
        VALUES (@id, @name, @network, @wasm_hash, @tags)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            network = excluded.network,
            wasm_hash = excluded.wasm_hash,
            tags = excluded.tags
    `).run({
      id: contract.id,
      name: contract.name ?? null,
      network: contract.network,
      wasm_hash: contract.wasm_hash ?? null,
      tags: contract.tags ?? null,
    });
}

export function getContract(db: Database.Database, id: string): Contract | undefined {
  return db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as Contract | undefined;
}

export function getAllContracts(db: Database.Database): Contract[] {
  return db.prepare("SELECT * FROM contracts").all() as Contract[];
}

export function updateLastCheckedLedger(db: Database.Database, contractId: string, ledger: number): void {
  db.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(ledger, contractId);
}

export function deleteContract(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM contracts WHERE id = ?").run(id);
}

// ---------------------------- Database Access Functions For Schema: ContractEntry ----------------------------
export function upsertEntry(db: Database.Database, entry: {
  contract_id: string;
  entry_key_xdr: string;
  entry_type: string;
  label?: string;
  live_until_ledger?: number;
  last_modified_ledger?: number;
  discovery_source?: string;
}): void {
  db.prepare(`
    INSERT INTO contract_entries (contract_id, entry_key_xdr, entry_type, label, live_until_ledger, last_modified_ledger, discovery_source, last_checked_at)
    VALUES (@contract_id, @entry_key_xdr, @entry_type, @label, @live_until_ledger, @last_modified_ledger, @discovery_source, datetime('now'))
    ON CONFLICT(contract_id, entry_key_xdr) DO UPDATE SET
      live_until_ledger = @live_until_ledger,
      last_modified_ledger = @last_modified_ledger,
      last_checked_at = datetime('now')
  `).run({
    contract_id: entry.contract_id,
    entry_key_xdr: entry.entry_key_xdr,
    entry_type: entry.entry_type,
    label: entry.label ?? null,
    live_until_ledger: entry.live_until_ledger ?? null,
    last_modified_ledger: entry.last_modified_ledger ?? null,
    discovery_source: entry.discovery_source ?? "deterministic",
  });
}

export function getEntriesForContract(db: Database.Database, contractId: string): ContractEntry[] {
  return db.prepare("SELECT * FROM contract_entries WHERE contract_id = ?").all(contractId) as ContractEntry[];
}

// ---------------------------- Database Access Functions For Other Schema: ExtensionPolicy----------------------------
export function upsertExtensionPolicy(db: Database.Database, policy: {
  contract_id: string;
  enabled?: boolean;
  target_ttl_ledgers: number;
  extend_when_below_ledgers: number;
  keypair_public?: string;
  keypair_source?: string;
}): void {
  db.prepare(`
    INSERT INTO extension_policies (contract_id, enabled, target_ttl_ledgers, extend_when_below_ledgers, keypair_public, keypair_source)
    VALUES (@contract_id, @enabled, @target_ttl_ledgers, @extend_when_below_ledgers, @keypair_public, @keypair_source)
    ON CONFLICT(contract_id) DO UPDATE SET
      enabled = @enabled,
      target_ttl_ledgers = @target_ttl_ledgers,
      extend_when_below_ledgers = @extend_when_below_ledgers,
      keypair_public = @keypair_public,
      keypair_source = @keypair_source
  `).run({
    contract_id: policy.contract_id,
    enabled: policy.enabled !== false ? 1 : 0,
    target_ttl_ledgers: policy.target_ttl_ledgers,
    extend_when_below_ledgers: policy.extend_when_below_ledgers,
    keypair_public: policy.keypair_public ?? null,
    keypair_source: policy.keypair_source ?? null,
  });
}

export function getExtensionPolicy(db: Database.Database, contractId: string): ExtensionPolicy | undefined {
  return db.prepare("SELECT * FROM extension_policies WHERE contract_id = ?").get(contractId) as ExtensionPolicy | undefined;
}

// ---------------------------- Database Access Functions For Other Schema: AlertConfig----------------------------
export function insertAlertConfig(db: Database.Database, config: {
  contract_id: string;
  channel_type: string;
  channel_target: string;
  threshold_ledgers: number;
  webhook_secret?: string;
}): void {
  db.prepare(`
    INSERT INTO alert_configs (contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret)
    VALUES (@contract_id, @channel_type, @channel_target, @threshold_ledgers, @webhook_secret)
  `).run({
    ...config,
    webhook_secret: config.webhook_secret ?? null,
  });
}

export function getAlertConfigById(db: Database.Database, id: number): AlertConfig | undefined {
  return db.prepare("SELECT * FROM alert_configs WHERE id = ?").get(id) as AlertConfig | undefined;
}

export function getAlertConfigsForContract(db: Database.Database, contractId: string): AlertConfig[] {
  return db.prepare("SELECT * FROM alert_configs WHERE contract_id = ?").all(contractId) as AlertConfig[];
}

export function deleteAlertConfig(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM alert_configs WHERE id = ?").run(id);
}

// ---------------------------- Database Access Functions For Other Schema: AlertFired----------------------------
export function recordAlertFired(db: Database.Database, alert: {
  alert_config_id: number;
  contract_entry_id: number;
  fired_at_ledger: number;
  ttl_at_fire: number;
}): void {
  db.prepare(`
    INSERT INTO alerts_fired (alert_config_id, contract_entry_id, fired_at_ledger, ttl_at_fire)
    VALUES (@alert_config_id, @contract_entry_id, @fired_at_ledger, @ttl_at_fire)
  `).run(alert);
}

export function hasUnresolvedAlert(db: Database.Database, alertConfigId: number, entryId: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM alerts_fired
    WHERE alert_config_id = ? AND contract_entry_id = ? AND resolved = 0
    LIMIT 1
  `).get(alertConfigId, entryId);
  return row !== undefined;
}

export function resolveAlerts(db: Database.Database, entryId: number): number[] {
  const rows = db.prepare(`
    SELECT alert_config_id FROM alerts_fired
    WHERE contract_entry_id = ? AND resolved = 0
  `).all(entryId) as { alert_config_id: number }[];

  if (rows.length > 0) {
    db.prepare(`
      UPDATE alerts_fired SET resolved = 1, resolved_at = datetime('now')
      WHERE contract_entry_id = ? AND resolved = 0
    `).run(entryId);
  }

  return rows.map(r => r.alert_config_id);
}

// ---------------------------- Database Access Functions For Other Schema: ExtensionRecord----------------------------
export function recordExtension(db: Database.Database, record: {
  contract_id: string;
  contract_entry_id: number;
  old_ttl_ledgers: number;
  new_ttl_ledgers: number;
  tx_hash: string;
  cost_xlm?: number;
  executed_at_ledger: number;
}): void {
  db.prepare(`
    INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, executed_at_ledger)
    VALUES (@contract_id, @contract_entry_id, @old_ttl_ledgers, @new_ttl_ledgers, @tx_hash, @cost_xlm, @executed_at_ledger)
  `).run({
    ...record,
    cost_xlm: record.cost_xlm ?? null,
  });
}

export function getExtensionHistory(db: Database.Database, contractId: string, days?: number): ExtensionRecord[] {
  if (days) {
    return db.prepare(`
      SELECT * FROM extension_history
      WHERE contract_id = ? AND executed_at >= datetime('now', ?)
      ORDER BY executed_at DESC
    `).all(contractId, `-${days} days`) as ExtensionRecord[];
  }
  return db.prepare(`
    SELECT * FROM extension_history WHERE contract_id = ? ORDER BY executed_at DESC
  `).all(contractId) as ExtensionRecord[];
}

export interface CostDailySnapshot {
    id: number;
    contract_id: string;
    snapshot_date: string;
    total_extensions: number;
    total_cost_xlm: number;
    instance_extensions: number;
    instance_cost_xlm: number;
    wasm_extensions: number;
    wasm_cost_xlm: number;
    persistent_extensions: number;
    persistent_cost_xlm: number;
    temporary_extensions: number;
    temporary_cost_xlm: number;
    created_at: string;
}

export interface ContractCostSummary {
    contract_id: string;
    total_extensions: number;
    total_cost_xlm: number;
    byType: {
        instance: { count: number; cost_xlm: number };
        wasm: { count: number; cost_xlm: number };
        persistent: { count: number; cost_xlm: number };
        temporary: { count: number; cost_xlm: number };
    };
}

export function aggregateDailyCostSnapshots(db: Database.Database): void {
    const rows = db.prepare(`
        SELECT
            eh.contract_id AS contract_id,
            date(eh.executed_at) AS snapshot_date,
            COUNT(*) AS total_extensions,
            SUM(COALESCE(eh.cost_xlm, 0.0)) AS total_cost_xlm,
            SUM(CASE WHEN ce.entry_type = 'instance' THEN 1 ELSE 0 END) AS instance_extensions,
            SUM(CASE WHEN ce.entry_type = 'instance' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END) AS instance_cost_xlm,
            SUM(CASE WHEN ce.entry_type = 'wasm' THEN 1 ELSE 0 END) AS wasm_extensions,
            SUM(CASE WHEN ce.entry_type = 'wasm' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END) AS wasm_cost_xlm,
            SUM(CASE WHEN ce.entry_type = 'persistent' THEN 1 ELSE 0 END) AS persistent_extensions,
            SUM(CASE WHEN ce.entry_type = 'persistent' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END) AS persistent_cost_xlm,
            SUM(CASE WHEN ce.entry_type = 'temporary' THEN 1 ELSE 0 END) AS temporary_extensions,
            SUM(CASE WHEN ce.entry_type = 'temporary' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END) AS temporary_cost_xlm
        FROM extension_history eh
        JOIN contract_entries ce ON ce.id = eh.contract_entry_id
        WHERE date(eh.executed_at) < date('now')
        GROUP BY eh.contract_id, date(eh.executed_at)
    `).all() as Array<Omit<CostDailySnapshot, 'id' | 'created_at'>>;

    const upsert = db.prepare(`
        INSERT INTO cost_daily_snapshots (
            contract_id, snapshot_date,
            total_extensions, total_cost_xlm,
            instance_extensions, instance_cost_xlm,
            wasm_extensions, wasm_cost_xlm,
            persistent_extensions, persistent_cost_xlm,
            temporary_extensions, temporary_cost_xlm
        ) VALUES (
            @contract_id, @snapshot_date,
            @total_extensions, @total_cost_xlm,
            @instance_extensions, @instance_cost_xlm,
            @wasm_extensions, @wasm_cost_xlm,
            @persistent_extensions, @persistent_cost_xlm,
            @temporary_extensions, @temporary_cost_xlm
        )
        ON CONFLICT(contract_id, snapshot_date) DO UPDATE SET
            total_extensions = excluded.total_extensions,
            total_cost_xlm = excluded.total_cost_xlm,
            instance_extensions = excluded.instance_extensions,
            instance_cost_xlm = excluded.instance_cost_xlm,
            wasm_extensions = excluded.wasm_extensions,
            wasm_cost_xlm = excluded.wasm_cost_xlm,
            persistent_extensions = excluded.persistent_extensions,
            persistent_cost_xlm = excluded.persistent_cost_xlm,
            temporary_extensions = excluded.temporary_extensions,
            temporary_cost_xlm = excluded.temporary_cost_xlm
    `);

    const transaction = db.transaction((snapshotRows: Array<typeof rows[number]>) => {
        for (const row of snapshotRows) {
            upsert.run(row);
        }
    });

    transaction(rows);
}

export function getCostDailySnapshots(db: Database.Database, contractId: string, days?: number): CostDailySnapshot[] {
    if (days) {
        return db.prepare(`
            SELECT * FROM cost_daily_snapshots
            WHERE contract_id = ? AND snapshot_date >= date('now', ?)
            ORDER BY snapshot_date DESC
        `).all(contractId, `-${Math.max(days - 1, 0)} days`) as CostDailySnapshot[];
    }
    return db.prepare(`
        SELECT * FROM cost_daily_snapshots
        WHERE contract_id = ?
        ORDER BY snapshot_date DESC
    `).all(contractId) as CostDailySnapshot[];
}

export function getContractCostSummary(db: Database.Database, contractId: string, days?: number) : ContractCostSummary {
    const snapshotParams = days ? [`-${Math.max(days - 1, 0)} days`] : [];
    const snapshotRow = days
        ? db.prepare(`
            SELECT
                COALESCE(SUM(total_extensions), 0) AS total_extensions,
                COALESCE(SUM(total_cost_xlm), 0.0) AS total_cost_xlm,
                COALESCE(SUM(instance_extensions), 0) AS instance_extensions,
                COALESCE(SUM(instance_cost_xlm), 0.0) AS instance_cost_xlm,
                COALESCE(SUM(wasm_extensions), 0) AS wasm_extensions,
                COALESCE(SUM(wasm_cost_xlm), 0.0) AS wasm_cost_xlm,
                COALESCE(SUM(persistent_extensions), 0) AS persistent_extensions,
                COALESCE(SUM(persistent_cost_xlm), 0.0) AS persistent_cost_xlm,
                COALESCE(SUM(temporary_extensions), 0) AS temporary_extensions,
                COALESCE(SUM(temporary_cost_xlm), 0.0) AS temporary_cost_xlm
            FROM cost_daily_snapshots
            WHERE contract_id = ? AND snapshot_date >= date('now', ?)
        `).get(contractId, ...snapshotParams)
        : db.prepare(`
            SELECT
                COALESCE(SUM(total_extensions), 0) AS total_extensions,
                COALESCE(SUM(total_cost_xlm), 0.0) AS total_cost_xlm,
                COALESCE(SUM(instance_extensions), 0) AS instance_extensions,
                COALESCE(SUM(instance_cost_xlm), 0.0) AS instance_cost_xlm,
                COALESCE(SUM(wasm_extensions), 0) AS wasm_extensions,
                COALESCE(SUM(wasm_cost_xlm), 0.0) AS wasm_cost_xlm,
                COALESCE(SUM(persistent_extensions), 0) AS persistent_extensions,
                COALESCE(SUM(persistent_cost_xlm), 0.0) AS persistent_cost_xlm,
                COALESCE(SUM(temporary_extensions), 0) AS temporary_extensions,
                COALESCE(SUM(temporary_cost_xlm), 0.0) AS temporary_cost_xlm
            FROM cost_daily_snapshots
            WHERE contract_id = ?
        `).get(contractId);

    const currentDayRow = db.prepare(`
        SELECT
            COUNT(*) AS total_extensions,
            COALESCE(SUM(COALESCE(eh.cost_xlm, 0.0)), 0.0) AS total_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'instance' THEN 1 ELSE 0 END), 0) AS instance_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'instance' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS instance_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'wasm' THEN 1 ELSE 0 END), 0) AS wasm_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'wasm' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS wasm_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'persistent' THEN 1 ELSE 0 END), 0) AS persistent_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'persistent' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS persistent_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'temporary' THEN 1 ELSE 0 END), 0) AS temporary_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'temporary' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS temporary_cost_xlm
        FROM extension_history eh
        JOIN contract_entries ce ON ce.id = eh.contract_entry_id
        WHERE eh.contract_id = ?
          AND date(eh.executed_at) = date('now')
    `).get(contractId);

    return {
        contract_id: contractId,
        total_extensions: Number((snapshotRow.total_extensions ?? 0) + (currentDayRow.total_extensions ?? 0)),
        total_cost_xlm: Number((snapshotRow.total_cost_xlm ?? 0) + (currentDayRow.total_cost_xlm ?? 0)),
        byType: {
            instance: {
                count: Number((snapshotRow.instance_extensions ?? 0) + (currentDayRow.instance_extensions ?? 0)),
                cost_xlm: Number((snapshotRow.instance_cost_xlm ?? 0) + (currentDayRow.instance_cost_xlm ?? 0)),
            },
            wasm: {
                count: Number((snapshotRow.wasm_extensions ?? 0) + (currentDayRow.wasm_extensions ?? 0)),
                cost_xlm: Number((snapshotRow.wasm_cost_xlm ?? 0) + (currentDayRow.wasm_cost_xlm ?? 0)),
            },
            persistent: {
                count: Number((snapshotRow.persistent_extensions ?? 0) + (currentDayRow.persistent_extensions ?? 0)),
                cost_xlm: Number((snapshotRow.persistent_cost_xlm ?? 0) + (currentDayRow.persistent_cost_xlm ?? 0)),
            },
            temporary: {
                count: Number((snapshotRow.temporary_extensions ?? 0) + (currentDayRow.temporary_extensions ?? 0)),
                cost_xlm: Number((snapshotRow.temporary_cost_xlm ?? 0) + (currentDayRow.temporary_cost_xlm ?? 0)),
            },
        },
    };
}

// ---------------------------- Alert Delivery ----------------------------

/**
 * The fully-joined shape returned by getUndeliveredAlerts.
 * Contains everything the dispatcher needs to build and route an AlertEvent
 * without any further DB lookups.
 */
export interface UndeliveredAlert {
    alertFiredId: number;
    alertConfigId: number;
    contractId: string;
    contractName: string | null;
    network: string;
    entryId: number;
    entryKeyXdr: string;
    entryType: string;
    entryLabel: string | null;
    channelType: "webhook" | "slack";
    channelTarget: string;
    thresholdLedgers: number;
    webhookSecret: string | null;
    /** TTL remaining at the moment the alert fired (ttl_at_fire). */
    remainingTTL: number;
    firedAtLedger: number;
    firedAt: string;
    retryCount: number;
}

/** Maximum number of delivery attempts before giving up on an alert. */
export const MAX_RETRY_COUNT = 5;

/**
 * Return all undelivered (delivered = 0) alerts for the given network,
 * joining alerts_fired → alert_configs → contract_entries → contracts.
 * Alerts that have exceeded MAX_RETRY_COUNT are excluded.
 */
export function getUndeliveredAlerts(
    db: Database.Database,
    network: string,
): UndeliveredAlert[] {
    const rows = db.prepare(`
        SELECT
            af.id            AS alertFiredId,
            ac.id            AS alertConfigId,
            c.id             AS contractId,
            c.name           AS contractName,
            c.network        AS network,
            ce.id            AS entryId,
            ce.entry_key_xdr AS entryKeyXdr,
            ce.entry_type    AS entryType,
            ce.label         AS entryLabel,
            ac.channel_type  AS channelType,
            ac.channel_target AS channelTarget,
            ac.threshold_ledgers AS thresholdLedgers,
            ac.webhook_secret AS webhookSecret,
            af.ttl_at_fire   AS remainingTTL,
            af.fired_at_ledger AS firedAtLedger,
            af.fired_at      AS firedAt,
            af.retry_count   AS retryCount
        FROM alerts_fired af
        JOIN alert_configs ac  ON ac.id  = af.alert_config_id
        JOIN contract_entries ce ON ce.id = af.contract_entry_id
        JOIN contracts c       ON c.id  = ce.contract_id
        WHERE af.delivered = 0
          AND af.retry_count < ?
          AND c.network = ?
        ORDER BY af.fired_at ASC
    `).all(MAX_RETRY_COUNT, network) as UndeliveredAlert[];

    return rows;
}

/**
 * Mark a single alerts_fired record as delivered.
 * Idempotent — safe to call more than once.
 */
export function markAlertDelivered(db: Database.Database, alertFiredId: number): void {
    db.prepare(`
        UPDATE alerts_fired
        SET delivered = 1, delivered_at = datetime('now')
        WHERE id = ?
    `).run(alertFiredId);
}

/**
 * Increment the retry count for a failed alert delivery.
 */
export function incrementRetryCount(db: Database.Database, alertFiredId: number): void {
    db.prepare(`
        UPDATE alerts_fired
        SET retry_count = retry_count + 1
        WHERE id = ?
    `).run(alertFiredId);
}

/**
 * Get alert history for a contract. Returns fired alerts with config and entry info.
 */
export interface AlertHistoryRecord {
    alertFiredId: number;
    channelType: string;
    channelTarget: string;
    entryKeyXdr: string;
    entryType: string;
    entryLabel: string | null;
    thresholdLedgers: number;
    ttlAtFire: number;
    firedAtLedger: number;
    firedAt: string;
    resolved: number;
    resolvedAt: string | null;
    delivered: number;
    deliveredAt: string | null;
    retryCount: number;
}

export function getAlertHistory(db: Database.Database, contractId: string, limit?: number): AlertHistoryRecord[] {
    const sql = `
        SELECT
            af.id              AS alertFiredId,
            ac.channel_type    AS channelType,
            ac.channel_target  AS channelTarget,
            ce.entry_key_xdr   AS entryKeyXdr,
            ce.entry_type      AS entryType,
            ce.label           AS entryLabel,
            ac.threshold_ledgers AS thresholdLedgers,
            af.ttl_at_fire     AS ttlAtFire,
            af.fired_at_ledger AS firedAtLedger,
            af.fired_at        AS firedAt,
            af.resolved        AS resolved,
            af.resolved_at     AS resolvedAt,
            af.delivered        AS delivered,
            af.delivered_at    AS deliveredAt,
            af.retry_count     AS retryCount
        FROM alerts_fired af
        JOIN alert_configs ac  ON ac.id  = af.alert_config_id
        JOIN contract_entries ce ON ce.id = af.contract_entry_id
        WHERE ac.contract_id = ?
        ORDER BY af.fired_at DESC
        ${limit ? "LIMIT ?" : ""}
    `;
    return (limit
        ? db.prepare(sql).all(contractId, limit)
        : db.prepare(sql).all(contractId)
    ) as AlertHistoryRecord[];
}
