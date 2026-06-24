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

export interface StateSnapshot {
    id: number;
    contract_entry_id: number;
    snapshot_ledger: number;
    value_hash: string;
    value_xdr: string;
    created_at: string;
}

export interface StateChange {
    id: number;
    contract_entry_id: number;
    old_snapshot_id: number | null;
    new_snapshot_id: number | null;
    diff_type: "created" | "updated" | "deleted";
    diff_json: string;
    detected_at_ledger: number;
    created_at: string;
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

// ---------------------------- Database Access Functions For Schema: StateSnapshot ----------------------------
export function insertStateSnapshot(db: Database.Database, snapshot: {
    contract_entry_id: number;
    snapshot_ledger: number;
    value_hash: string;
    value_xdr: string;
}): number {
    const result = db.prepare(`
        INSERT INTO state_snapshots (contract_entry_id, snapshot_ledger, value_hash, value_xdr)
        VALUES (@contract_entry_id, @snapshot_ledger, @value_hash, @value_xdr)
    `).run(snapshot);
    return result.lastInsertRowid as number;
}

export function getLatestSnapshot(db: Database.Database, contractEntryId: number): StateSnapshot | undefined {
    return db.prepare(`
        SELECT * FROM state_snapshots
        WHERE contract_entry_id = ?
        ORDER BY snapshot_ledger DESC
        LIMIT 1
    `).get(contractEntryId) as StateSnapshot | undefined;
}

// ---------------------------- Database Access Functions For Schema: StateChange ----------------------------
export function insertStateChange(db: Database.Database, change: {
    contract_entry_id: number;
    old_snapshot_id?: number;
    new_snapshot_id?: number;
    diff_type: string;
    diff_json: string;
    detected_at_ledger: number;
}): number {
    const result = db.prepare(`
        INSERT INTO state_changes (contract_entry_id, old_snapshot_id, new_snapshot_id, diff_type, diff_json, detected_at_ledger)
        VALUES (@contract_entry_id, @old_snapshot_id, @new_snapshot_id, @diff_type, @diff_json, @detected_at_ledger)
    `).run({
        ...change,
        old_snapshot_id: change.old_snapshot_id ?? null,
        new_snapshot_id: change.new_snapshot_id ?? null,
    });
    return result.lastInsertRowid as number;
}

export function getStateChanges(db: Database.Database, contractEntryId: number, limit?: number): StateChange[] {
    let sql = "SELECT * FROM state_changes WHERE contract_entry_id = ? ORDER BY detected_at_ledger DESC";
    if (limit) {
        sql += " LIMIT ?";
        return db.prepare(sql).all(contractEntryId, limit) as StateChange[];
    }
    return db.prepare(sql).all(contractEntryId) as StateChange[];
}
