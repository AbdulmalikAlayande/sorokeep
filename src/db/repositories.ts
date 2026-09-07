import type Database from "better-sqlite3";

export interface Contract {
    id: string;
    name: string | null;
    network: string;
    wasm_hash: string | null;
    tags: string | null;
    poll_interval_seconds?: number | null;
    active: number;
    registered_at: Date;
    last_checked_ledger?: number | null;
    /** ISO-8601 timestamp of the last successful introspection (instance/WASM key discovery). NULL if never introspected. */
    last_introspected_at?: string | null;
}

export interface ContractEntry {
    id: number;
    contract_id: string;
    entry_key_xdr: string;
    entry_type: "instance" | "wasm" | "persistent" | "temporary";
    label: string | null;
    live_until_ledger: number;
    last_modified_ledger: number;
    discovery_source: "deterministic" | "manual" | "instance_scan" | "footprint" | "introspection";
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
    /** Hard per-transaction fee ceiling in stroops, or null for no ceiling (issue #420). */
    max_fee_stroops: number | null;
    created_at: Date;
    /** Number of daemon cycles ahead to project TTL crossing (issue #492). 0 = disabled. */
    predictive_cycles: number;
}

export interface AlertConfig {
    id: number;
    contract_id: string;
    channel_type: string;
    channel_target: string;
    threshold_ledgers: number;
    webhook_secret: string | null;
    /** HH:MM (24-hour) start of the quiet / maintenance window, or null if not configured. */
    quiet_hours_start: string | null;
    /** HH:MM (24-hour) end of the quiet / maintenance window, or null if not configured. */
    quiet_hours_end: string | null;
    /** IANA timezone name used to interpret quiet_hours_start / quiet_hours_end, or null. */
    quiet_hours_timezone: string | null;
    /** 1 = enabled, 0 = disabled (SQLite integer boolean). */
    enabled: number;
    created_at: Date;
}

export interface AlertConfigTarget {
    id: number;
    alert_config_id: number;
    channel_type: string;
    channel_target: string;
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
    cpu_insns: number | null;
    mem_bytes: number | null;
    is_anomaly: number;
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

export interface ContractGroup {
    id: number;
    name: string;
    poll_interval_seconds: number | null;
    created_at: string;
}

export interface ContractGroupMember {
    id: number;
    group_id: number;
    contract_id: string;
}

export { upsertBudget, getBudget, addBudgetSpent } from "./budget.js";

// ---------------------------- Database Access Functions For Schema: Contract ----------------------------
export function insertContract(db: Database.Database, contract: {id: string; name?: string; network: string; wasm_hash?: string; tags?: string; poll_interval_seconds?: number | null; active?: number}): void {
    db.prepare(`
        INSERT INTO contracts (id, name, network, wasm_hash, tags, poll_interval_seconds, active)
        VALUES (@id, @name, @network, @wasm_hash, @tags, @poll_interval_seconds, @active)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            network = excluded.network,
            wasm_hash = excluded.wasm_hash,
            tags = excluded.tags,
            poll_interval_seconds = COALESCE(excluded.poll_interval_seconds, contracts.poll_interval_seconds),
            active = COALESCE(excluded.active, contracts.active)
    `).run({
      id: contract.id,
      name: contract.name ?? null,
      network: contract.network,
      wasm_hash: contract.wasm_hash ?? null,
      tags: contract.tags ?? null,
      poll_interval_seconds: contract.poll_interval_seconds ?? null,
      active: contract.active ?? 1,
    });
}

export function getContract(db: Database.Database, id: string): Contract | undefined {
  return db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as Contract | undefined;
}

/**
 * Parse the comma-separated `tags` column into a list of trimmed, non-empty
 * tags. The format matches the one used by the exact-match `--tag` filter:
 * comma-separated values with surrounding whitespace trimmed.
 */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Persist the given tag list using the canonical comma-separated format.
 * An empty list is stored as NULL.
 */
function writeTags(db: Database.Database, contractId: string, tags: string[]): void {
  const value = tags.length > 0 ? tags.join(",") : null;
  db.prepare("UPDATE contracts SET tags = ? WHERE id = ?").run(value, contractId);
}

/**
 * Add a tag to a contract's tag list. Adding a tag that already exists is a
 * no-op (exact, trimmed match — same semantics as the `--tag` filter).
 *
 * @returns The resulting tag list after the mutation.
 * @throws If no contract is registered under `contractId`.
 */
export function addContractTag(db: Database.Database, contractId: string, tag: string): string[] {
  const contract = getContract(db, contractId);
  if (!contract) {
    throw new Error(`Contract ${contractId} is not registered.`);
  }

  const normalizedTag = tag.trim();
  if (!normalizedTag) {
    return parseTags(contract.tags);
  }

  const tags = parseTags(contract.tags);
  if (!tags.includes(normalizedTag)) {
    tags.push(normalizedTag);
    writeTags(db, contractId, tags);
  }
  return tags;
}

/**
 * Remove a tag from a contract's tag list. Removing a tag that is not present
 * is a no-op. When the last tag is removed the tags column is reset to NULL.
 *
 * @returns The resulting tag list after the mutation.
 * @throws If no contract is registered under `contractId`.
 */
export function removeContractTag(db: Database.Database, contractId: string, tag: string): string[] {
  const contract = getContract(db, contractId);
  if (!contract) {
    throw new Error(`Contract ${contractId} is not registered.`);
  }

  const normalizedTag = tag.trim();
  const tags = parseTags(contract.tags);
  const updated = tags.filter((existing) => existing !== normalizedTag);

  if (updated.length !== tags.length) {
    writeTags(db, contractId, updated);
  }
  return updated;
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

export function updateContractPollInterval(
  db: Database.Database,
  contractId: string,
  pollIntervalSeconds: number | null,
): void {
  db.prepare("UPDATE contracts SET poll_interval_seconds = ? WHERE id = ?").run(pollIntervalSeconds, contractId);
}

export function getContractPollInterval(
  db: Database.Database,
  contractId: string,
): number | null {
  const row = db.prepare("SELECT poll_interval_seconds FROM contracts WHERE id = ?").get(contractId) as { poll_interval_seconds: number | null } | undefined;
  return row?.poll_interval_seconds ?? null;
}

export function setContractActiveStatus(
  db: Database.Database,
  contractId: string,
  active: boolean
): void {
  db.prepare("UPDATE contracts SET active = ? WHERE id = ?").run(active ? 1 : 0, contractId);
}

/**
 * Record that a successful contract introspection (instance/WASM key discovery)
 * was performed at the given timestamp. Accepts an ISO-8601 string so callers
 * can control the clock in tests.
 */
export function updateLastIntrospectedAt(
  db: Database.Database,
  contractId: string,
  isoTimestamp: string,
): void {
  db.prepare(
    "UPDATE contracts SET last_introspected_at = ? WHERE id = ?",
  ).run(isoTimestamp, contractId);
}

/**
 * Return true when the introspection cache for the given contract is still
 * valid — i.e. `last_introspected_at` is not NULL and the timestamp is
 * strictly less than `maxAgeMs` milliseconds ago.
 *
 * The default max-age is 24 hours (86 400 000 ms).
 * The boundary is *exclusive on the valid side*: exactly 24 h ago is expired.
 */
export function isIntrospectionCacheValid(
  db: Database.Database,
  contractId: string,
  maxAgeMs = 24 * 60 * 60 * 1_000,
): boolean {
  const row = db
    .prepare(
      "SELECT last_introspected_at FROM contracts WHERE id = ?",
    )
    .get(contractId) as { last_introspected_at: string | null } | undefined;

  if (!row || row.last_introspected_at === null) return false;

  const introspectedAt = new Date(row.last_introspected_at).getTime();
  const ageMs = Date.now() - introspectedAt;
  // strictly less than → at exactly 24 h the cache is expired
  return ageMs < maxAgeMs;
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
  max_fee_stroops?: number | null;
  /** Daemon cycles ahead to project TTL crossing (issue #492). Omitted = preserve the existing value (0 for a new policy). */
  predictive_cycles?: number;
}): void {
  db.transaction(() => {
    // predictive_cycles is set independently via --predictive; callers updating
    // other fields (e.g. --disable, --auto-extend) omit it and must not
    // silently reset it back to 0.
    const existing = db.prepare(
      "SELECT predictive_cycles FROM extension_policies WHERE contract_id = ?",
    ).get(policy.contract_id) as { predictive_cycles: number } | undefined;

    const row = {
      contract_id: policy.contract_id,
      enabled: policy.enabled !== false ? 1 : 0,
      target_ttl_ledgers: policy.target_ttl_ledgers,
      extend_when_below_ledgers: policy.extend_when_below_ledgers,
      keypair_public: policy.keypair_public ?? null,
      keypair_source: policy.keypair_source ?? null,
      max_fee_stroops: policy.max_fee_stroops ?? null,
      predictive_cycles: policy.predictive_cycles ?? existing?.predictive_cycles ?? 0,
    };

    db.prepare(`
      INSERT INTO extension_policies (contract_id, enabled, target_ttl_ledgers, extend_when_below_ledgers, keypair_public, keypair_source, max_fee_stroops, predictive_cycles)
      VALUES (@contract_id, @enabled, @target_ttl_ledgers, @extend_when_below_ledgers, @keypair_public, @keypair_source, @max_fee_stroops, @predictive_cycles)
      ON CONFLICT(contract_id) DO UPDATE SET
        enabled = @enabled,
        target_ttl_ledgers = @target_ttl_ledgers,
        extend_when_below_ledgers = @extend_when_below_ledgers,
        keypair_public = @keypair_public,
        keypair_source = @keypair_source,
        max_fee_stroops = @max_fee_stroops,
        predictive_cycles = @predictive_cycles
    `).run(row);

    // Append-only version history (issue #506) — powers 'sorokeep guard rollback'.
    db.prepare(`
      INSERT INTO guard_policy_history (contract_id, enabled, target_ttl_ledgers, extend_when_below_ledgers, keypair_public, keypair_source, predictive_cycles)
      VALUES (@contract_id, @enabled, @target_ttl_ledgers, @extend_when_below_ledgers, @keypair_public, @keypair_source, @predictive_cycles)
    `).run(row);
  })();
}

export function getExtensionPolicy(db: Database.Database, contractId: string): ExtensionPolicy | undefined {
  return db.prepare("SELECT * FROM extension_policies WHERE contract_id = ?").get(contractId) as ExtensionPolicy | undefined;
}

export type EntryType = "instance" | "wasm" | "persistent" | "temporary";

/**
 * Resolves the effective TTL policy for a specific entry type.
 *
 * Resolution order:
 * 1. entry_type_policies row for (contractId, entryType) if it exists
 * 2. extension_policies row for contractId (contract-level default)
 * 3. undefined if neither exists (issue #491)
 */
export function getEffectivePolicy(
  db: Database.Database,
  contractId: string,
  entryType: EntryType,
): ExtensionPolicy | undefined {
  const override = db.prepare(`
    SELECT target_ttl_ledgers, extend_when_below_ledgers
    FROM entry_type_policies
    WHERE contract_id = ? AND entry_type = ?
  `).get(contractId, entryType) as { target_ttl_ledgers: number; extend_when_below_ledgers: number } | undefined;

  const defaultPolicy = getExtensionPolicy(db, contractId);

  if (!override) {
    return defaultPolicy;
  }

  // Type override supplies TTL parameters only — enabled/keypair are still
  // governed by the contract-level policy (an entry-type override cannot
  // enable auto-extension on its own, nor supply its own signing key).
  return {
    id: defaultPolicy?.id ?? 0,
    contract_id: contractId,
    enabled: defaultPolicy?.enabled ?? false,
    target_ttl_ledgers: override.target_ttl_ledgers,
    extend_when_below_ledgers: override.extend_when_below_ledgers,
    keypair_public: defaultPolicy?.keypair_public ?? null,
    keypair_source: defaultPolicy?.keypair_source ?? null,
    max_fee_stroops: defaultPolicy?.max_fee_stroops ?? null,
    created_at: defaultPolicy?.created_at ?? new Date(),
    predictive_cycles: defaultPolicy?.predictive_cycles ?? 0,
  };
}

/**
 * Sets or updates a per-entry-type policy override. Idempotent (UPSERT).
 */
export function setEntryTypePolicy(
  db: Database.Database,
  contractId: string,
  entryType: EntryType,
  policy: {
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
  },
): void {
  db.prepare(`
    INSERT INTO entry_type_policies (contract_id, entry_type, target_ttl_ledgers, extend_when_below_ledgers, created_at, updated_at)
    VALUES (@contract_id, @entry_type, @target_ttl_ledgers, @extend_when_below_ledgers, datetime('now'), datetime('now'))
    ON CONFLICT(contract_id, entry_type) DO UPDATE SET
      target_ttl_ledgers = excluded.target_ttl_ledgers,
      extend_when_below_ledgers = excluded.extend_when_below_ledgers,
      updated_at = datetime('now')
  `).run({
    contract_id: contractId,
    entry_type: entryType,
    target_ttl_ledgers: policy.target_ttl_ledgers,
    extend_when_below_ledgers: policy.extend_when_below_ledgers,
  });
}

/**
 * Removes a per-entry-type policy override. After removal, the
 * contract-level default applies again. Idempotent.
 */
export function deleteEntryTypePolicy(
  db: Database.Database,
  contractId: string,
  entryType: string,
): void {
  db.prepare(`
    DELETE FROM entry_type_policies
    WHERE contract_id = ? AND entry_type = ?
  `).run(contractId, entryType);
}

// ---------------------------- Database Access Functions For Other Schema: AlertConfig----------------------------
export function insertAlertConfig(db: Database.Database, config: {
  contract_id: string;
  channel_type: string;
  channel_target: string;
  threshold_ledgers: number;
  webhook_secret?: string | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  quiet_hours_timezone?: string | null;
}): number {
  const info = db.prepare(`
    INSERT INTO alert_configs (contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret, quiet_hours_start, quiet_hours_end, quiet_hours_timezone)
    VALUES (@contract_id, @channel_type, @channel_target, @threshold_ledgers, @webhook_secret, @quiet_hours_start, @quiet_hours_end, @quiet_hours_timezone)
  `).run({
    ...config,
    webhook_secret: config.webhook_secret ?? null,
    quiet_hours_start: config.quiet_hours_start ?? null,
    quiet_hours_end: config.quiet_hours_end ?? null,
    quiet_hours_timezone: config.quiet_hours_timezone ?? null,
  });
  return info.lastInsertRowid as number;
}

export function getAlertConfigTargets(db: Database.Database, alertConfigId: number): AlertConfigTarget[] {
  return db.prepare(`SELECT * FROM alert_config_targets WHERE alert_config_id = ?`).all(alertConfigId) as AlertConfigTarget[];
}

export function addTargetToAlertConfig(db: Database.Database, alertConfigId: number, channelType: string, channelTarget: string): void {
  db.prepare(`
    INSERT INTO alert_config_targets (alert_config_id, channel_type, channel_target)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(alertConfigId, channelType, channelTarget);
}

export function removeTargetFromAlertConfig(db: Database.Database, alertConfigId: number, channelType: string, channelTarget: string): void {
  db.prepare(`
    DELETE FROM alert_config_targets
    WHERE alert_config_id = ? AND channel_type = ? AND channel_target = ?
  `).run(alertConfigId, channelType, channelTarget);
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

export function setAlertConfigEnabled(db: Database.Database, id: number, enabled: boolean): void {
  db.prepare("UPDATE alert_configs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

/**
 * Rotate the HMAC signing secret for an existing alert config row.
 * Only the `webhook_secret` column is touched; every other column is left unchanged.
 *
 * @returns `true` if the row was found and updated, `false` if no row with that `id` exists.
 */
export function updateAlertConfigSecret(
  db: Database.Database,
  id: number,
  newSecret: string,
): boolean {
  const result = db
    .prepare("UPDATE alert_configs SET webhook_secret = ? WHERE id = ?")
    .run(newSecret, id);
  return result.changes > 0;
}

// ---------------------------- Database Access Functions For Other Schema: AlertFired----------------------------
export function recordAlertFired(db: Database.Database, alert: {
  alert_config_id: number;
  contract_entry_id: number;
  fired_at_ledger: number;
  ttl_at_fire: number;
  channel_type?: string;
  channel_target?: string;
}): void {
  db.prepare(`
    INSERT INTO alerts_fired (alert_config_id, contract_entry_id, fired_at_ledger, ttl_at_fire, channel_type, channel_target)
    VALUES (@alert_config_id, @contract_entry_id, @fired_at_ledger, @ttl_at_fire, @channel_type, @channel_target)
  `).run({
    ...alert,
    channel_type: alert.channel_type ?? null,
    channel_target: alert.channel_target ?? null
  });
}

export function hasUnresolvedAlert(db: Database.Database, alertConfigId: number, entryId: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM alerts_fired
    WHERE alert_config_id = ? AND contract_entry_id = ? AND resolved = 0
    LIMIT 1
  `).get(alertConfigId, entryId) as { 1: number } | undefined;
  return row !== undefined;
}

export function resolveAlerts(db: Database.Database, entryId: number, alertConfigId: number): number[] {
  const rows = db.prepare(`
    SELECT alert_config_id FROM alerts_fired
    WHERE contract_entry_id = ? AND alert_config_id = ? AND resolved = 0
  `).all(entryId, alertConfigId) as { alert_config_id: number }[];

  if (rows.length > 0) {
    db.prepare(`
      UPDATE alerts_fired SET resolved = 1, resolved_at = datetime('now')
      WHERE contract_entry_id = ? AND alert_config_id = ? AND resolved = 0
    `).run(entryId, alertConfigId);
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
  cost_xlm?: number | null;
  cpu_insns?: number | null;
  mem_bytes?: number | null;
  is_anomaly?: boolean;
  executed_at_ledger: number;
}): void {
  db.prepare(`
    INSERT INTO extension_history (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, cost_xlm, cpu_insns, mem_bytes, is_anomaly, executed_at_ledger)
    VALUES (@contract_id, @contract_entry_id, @old_ttl_ledgers, @new_ttl_ledgers, @tx_hash, @cost_xlm, @cpu_insns, @mem_bytes, @is_anomaly, @executed_at_ledger)
  `).run({
    ...record,
    cost_xlm: record.cost_xlm ?? null,
    cpu_insns: record.cpu_insns ?? null,
    mem_bytes: record.mem_bytes ?? null,
    is_anomaly: record.is_anomaly ? 1 : 0,
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

export interface AuditLogRecord {
    tx_hash: string;
    contract_id: string;
    entry_key_xdr: string;
    entry_type: string;
    entry_label: string | null;
    old_ttl_ledgers: number;
    new_ttl_ledgers: number;
    cost_xlm: number | null;
    executed_at: string;
}

/**
 * Read-only export of extension_history joined with its entry, for the
 * `sorokeep audit-log` command's JSONL output — an append-only, compliance-
 * facing record of every TTL-extension transaction sorokeep has submitted.
 */
export function getAuditLogExtensions(db: Database.Database, since?: string): AuditLogRecord[] {
    let query = `
        SELECT
            eh.tx_hash AS tx_hash,
            eh.contract_id AS contract_id,
            ce.entry_key_xdr AS entry_key_xdr,
            ce.entry_type AS entry_type,
            ce.label AS entry_label,
            eh.old_ttl_ledgers AS old_ttl_ledgers,
            eh.new_ttl_ledgers AS new_ttl_ledgers,
            eh.cost_xlm AS cost_xlm,
            eh.executed_at AS executed_at
        FROM extension_history eh
        JOIN contract_entries ce ON eh.contract_entry_id = ce.id
    `;
    const params: string[] = [];
    if (since) {
        query += ` WHERE eh.executed_at >= ?`;
        params.push(since);
    }
    query += ` ORDER BY eh.executed_at ASC`;
    return db.prepare(query).all(...params) as AuditLogRecord[];
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
          AND date(eh.executed_at) >= date('now', '-7 days')
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
    interface CostAggregateRow {
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
    }

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
        `).get(contractId, ...snapshotParams) as CostAggregateRow

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
        `).get(contractId) as CostAggregateRow;


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
    `).get(contractId) as CostAggregateRow;


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

// ─── Fleet Cost Rollup ────────────────────────────────────────────────────────

/**
 * Aggregated cost data for an entire fleet of contracts.
 */
export interface FleetCostRollup {
    /** Total number of extension operations across the fleet in the period. */
    total_extensions: number;
    /** Total XLM spent on extensions across the fleet in the period. */
    total_cost_xlm: number;
    /** Number of distinct contracts contributing to this rollup. */
    contract_count: number;
    /** Per-entry-type breakdown at the fleet level. */
    byType: {
        instance: { count: number; cost_xlm: number };
        wasm: { count: number; cost_xlm: number };
        persistent: { count: number; cost_xlm: number };
        temporary: { count: number; cost_xlm: number };
    };
}

/**
 * Return a single aggregated cost row that sums `cost_daily_snapshots` across
 * ALL registered contracts, optionally filtered by tag and/or time window.
 *
 * The result mirrors the structure of {@link ContractCostSummary} but spans
 * the entire fleet rather than a single contract. Like getContractCostSummary,
 * it combines:
 *  1. Daily snapshots already written to `cost_daily_snapshots` (yesterday and
 *     earlier, within the requested window).
 *  2. Today's live data read directly from `extension_history`.
 *
 * Tag filtering uses a simple `LIKE '%<tag>%'` pattern against the
 * `contracts.tags` TEXT column (comma-separated). This is intentionally
 * liberal — "defi" will match "defi", "defi,bridge", and "bridge,defi".
 *
 * @param db      - The SQLite database connection.
 * @param options - Optional filters:
 *   - `tag`  — Restrict rollup to contracts whose `tags` field contains this
 *               value.
 *   - `days` — Restrict rollup to the last N days (inclusive of today's live
 *               data). Omit for all-time.
 */
export function getFleetCostRollup(
    db: Database.Database,
    options?: { tag?: string; days?: number },
): FleetCostRollup {
    interface AggregateRow {
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
        contract_count: number;
    }

    const tag = options?.tag;
    const days = options?.days;

    // ── 1. Aggregate from cost_daily_snapshots (historical, before today) ──
    const snapshotConditions: string[] = [];
    const snapshotParams: (string | number)[] = [];

    if (tag) {
        snapshotConditions.push(`c.tags LIKE ?`);
        snapshotParams.push(`%${tag}%`);
    }
    if (days !== undefined) {
        snapshotConditions.push(`cds.snapshot_date >= date('now', ?)`);
        snapshotParams.push(`-${Math.max(days - 1, 0)} days`);
    }

    const snapshotWhere =
        snapshotConditions.length > 0
            ? `WHERE ${snapshotConditions.join(" AND ")}`
            : "";

    const snapshotRow = db.prepare(`
        SELECT
            COALESCE(SUM(cds.total_extensions), 0)     AS total_extensions,
            COALESCE(SUM(cds.total_cost_xlm), 0.0)     AS total_cost_xlm,
            COALESCE(SUM(cds.instance_extensions), 0)  AS instance_extensions,
            COALESCE(SUM(cds.instance_cost_xlm), 0.0)  AS instance_cost_xlm,
            COALESCE(SUM(cds.wasm_extensions), 0)      AS wasm_extensions,
            COALESCE(SUM(cds.wasm_cost_xlm), 0.0)      AS wasm_cost_xlm,
            COALESCE(SUM(cds.persistent_extensions), 0) AS persistent_extensions,
            COALESCE(SUM(cds.persistent_cost_xlm), 0.0) AS persistent_cost_xlm,
            COALESCE(SUM(cds.temporary_extensions), 0) AS temporary_extensions,
            COALESCE(SUM(cds.temporary_cost_xlm), 0.0) AS temporary_cost_xlm,
            COUNT(DISTINCT cds.contract_id)             AS contract_count
        FROM cost_daily_snapshots cds
        JOIN contracts c ON c.id = cds.contract_id
        ${snapshotWhere}
    `).get(...snapshotParams) as AggregateRow;

    // ── 2. Aggregate today's live data from extension_history ──────────────
    const liveConditions: string[] = [`date(eh.executed_at) = date('now')`];
    const liveParams: (string | number)[] = [];

    if (tag) {
        liveConditions.push(`c.tags LIKE ?`);
        liveParams.push(`%${tag}%`);
    }

    const liveRow = db.prepare(`
        SELECT
            COUNT(*)                                        AS total_extensions,
            COALESCE(SUM(COALESCE(eh.cost_xlm, 0.0)), 0.0) AS total_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'instance'   THEN 1    ELSE 0   END), 0) AS instance_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'instance'   THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS instance_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'wasm'       THEN 1    ELSE 0   END), 0) AS wasm_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'wasm'       THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS wasm_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'persistent' THEN 1    ELSE 0   END), 0) AS persistent_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'persistent' THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS persistent_cost_xlm,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'temporary'  THEN 1    ELSE 0   END), 0) AS temporary_extensions,
            COALESCE(SUM(CASE WHEN ce.entry_type = 'temporary'  THEN COALESCE(eh.cost_xlm, 0.0) ELSE 0 END), 0.0) AS temporary_cost_xlm,
            COUNT(DISTINCT eh.contract_id)                  AS contract_count
        FROM extension_history eh
        JOIN contract_entries ce ON ce.id = eh.contract_entry_id
        JOIN contracts c ON c.id = eh.contract_id
        WHERE ${liveConditions.join(" AND ")}
    `).get(...liveParams) as AggregateRow;

    // ── 3. Merge snapshot + live ─────────────────────────────────────────
    // contract_count needs a UNION over both sources so a contract present in
    // both isn't double-counted.
    const contractCountRow = db.prepare(`
        SELECT COUNT(DISTINCT contract_id) AS n
        FROM (
            SELECT DISTINCT cds.contract_id
            FROM cost_daily_snapshots cds
            JOIN contracts c ON c.id = cds.contract_id
            ${tag ? `WHERE c.tags LIKE ?` : ""}
            UNION
            SELECT DISTINCT eh.contract_id
            FROM extension_history eh
            JOIN contracts c ON c.id = eh.contract_id
            WHERE date(eh.executed_at) = date('now')
            ${tag ? `AND c.tags LIKE ?` : ""}
        ) combined
    `).get(...(tag ? [`%${tag}%`, `%${tag}%`] : [])) as { n: number };

    return {
        total_extensions: Number(
            (snapshotRow.total_extensions ?? 0) + (liveRow.total_extensions ?? 0),
        ),
        total_cost_xlm: Number(
            (snapshotRow.total_cost_xlm ?? 0) + (liveRow.total_cost_xlm ?? 0),
        ),
        contract_count: contractCountRow.n ?? 0,
        byType: {
            instance: {
                count: Number(
                    (snapshotRow.instance_extensions ?? 0) + (liveRow.instance_extensions ?? 0),
                ),
                cost_xlm: Number(
                    (snapshotRow.instance_cost_xlm ?? 0) + (liveRow.instance_cost_xlm ?? 0),
                ),
            },
            wasm: {
                count: Number(
                    (snapshotRow.wasm_extensions ?? 0) + (liveRow.wasm_extensions ?? 0),
                ),
                cost_xlm: Number(
                    (snapshotRow.wasm_cost_xlm ?? 0) + (liveRow.wasm_cost_xlm ?? 0),
                ),
            },
            persistent: {
                count: Number(
                    (snapshotRow.persistent_extensions ?? 0) + (liveRow.persistent_extensions ?? 0),
                ),
                cost_xlm: Number(
                    (snapshotRow.persistent_cost_xlm ?? 0) + (liveRow.persistent_cost_xlm ?? 0),
                ),
            },
            temporary: {
                count: Number(
                    (snapshotRow.temporary_extensions ?? 0) + (liveRow.temporary_extensions ?? 0),
                ),
                cost_xlm: Number(
                    (snapshotRow.temporary_cost_xlm ?? 0) + (liveRow.temporary_cost_xlm ?? 0),
                ),
            },
        },
    };
}

/**
 * Count the number of auto-extension transactions that were executed for the
 * given contract within the last hour.
 *
 * Used by the rate limiter to enforce a maximum of N extensions per hour
 * per contract (issue #142).
 *
 * @param db - The SQLite database connection.
 * @param contractId - The contract to check.
 * @returns The number of extensions recorded in the last 60 minutes.
 */
export function countExtensionsInLastHour(db: Database.Database, contractId: string): number {
    const row = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM extension_history
        WHERE contract_id = ?
          AND datetime(executed_at) >= datetime('now', '-1 hour')
    `).get(contractId) as { cnt: number };
    return row?.cnt ?? 0;
}

export function getAverageResourceUsage(db: Database.Database, contractId: string, limit?: number): { avg_cpu_insns: number, avg_mem_bytes: number, count: number } | null {
  const params: (string | number)[] = [contractId];
  let query = `
    SELECT cpu_insns, mem_bytes
    FROM extension_history
    WHERE contract_id = ? AND cpu_insns IS NOT NULL AND mem_bytes IS NOT NULL
    ORDER BY executed_at DESC, id DESC
  `;
  if (limit !== undefined) {
    query += ` LIMIT ?`;
    params.push(limit);
  }
  const rows = db.prepare(query).all(...params) as { cpu_insns: number, mem_bytes: number }[];

  if (rows.length === 0) return null;

  const sumCpu = rows.reduce((acc, row) => acc + row.cpu_insns, 0);
  const sumMem = rows.reduce((acc, row) => acc + row.mem_bytes, 0);

  return {
    avg_cpu_insns: sumCpu / rows.length,
    avg_mem_bytes: sumMem / rows.length,
    count: rows.length
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
    /** Any registered alert channel name (see src/alerts/registry.ts) — not a fixed enum. */
    channelType: string;
    channelTarget: string;
    thresholdLedgers: number;
    webhookSecret: string | null;
    /** TTL remaining at the moment the alert fired (ttl_at_fire). */
    remainingTTL: number;
    firedAtLedger: number;
    firedAt: string;
    retryCount: number;
    /** HH:MM (24-hour) start of the quiet window, or null if not configured. */
    quietHoursStart: string | null;
    /** HH:MM (24-hour) end of the quiet window, or null if not configured. */
    quietHoursEnd: string | null;
    /** IANA timezone for the quiet window, or null if not configured. */
    quietHoursTimezone: string | null;
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
            COALESCE(af.channel_type, ac.channel_type)  AS channelType,
            COALESCE(af.channel_target, ac.channel_target) AS channelTarget,
            ac.threshold_ledgers AS thresholdLedgers,
            ac.webhook_secret AS webhookSecret,
            af.ttl_at_fire   AS remainingTTL,
            af.fired_at_ledger AS firedAtLedger,
            af.fired_at      AS firedAt,
            af.retry_count   AS retryCount,
            ac.quiet_hours_start    AS quietHoursStart,
            ac.quiet_hours_end      AS quietHoursEnd,
            ac.quiet_hours_timezone AS quietHoursTimezone
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
 * Count the number of undelivered alerts for the given network.
 * Uses the same filtering logic as getUndeliveredAlerts:
 * - delivered = 0
 * - retry_count < MAX_RETRY_COUNT
 * - matches the specified network
 */
export function countUndeliveredAlerts(
    db: Database.Database,
    network: string,
): number {
    const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM alerts_fired af
        JOIN alert_configs ac  ON ac.id  = af.alert_config_id
        JOIN contract_entries ce ON ce.id = af.contract_entry_id
        JOIN contracts c       ON c.id  = ce.contract_id
        WHERE af.delivered = 0
          AND af.retry_count < ?
          AND c.network = ?
    `).get(MAX_RETRY_COUNT, network) as { count: number };

    return row.count;
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
            COALESCE(af.channel_type, ac.channel_type)    AS channelType,
            COALESCE(af.channel_target, ac.channel_target)  AS channelTarget,
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

export interface ChannelDeliveryStats {
    totalAttempts: number;
    deliveredCount: number;
    failedCount: number;
    abandonedCount: number;
    successRate: number;
}

export function getChannelDeliveryStats(
    db: Database.Database,
    channelType: string,
    days?: number
): ChannelDeliveryStats {
    let sql = `
        SELECT
            COUNT(af.id) as totalAttempts,
            SUM(CASE WHEN af.delivered = 1 THEN 1 ELSE 0 END) as deliveredCount,
            SUM(CASE WHEN af.delivered = 0 AND af.retry_count >= ? THEN 1 ELSE 0 END) as abandonedCount,
            SUM(CASE WHEN af.delivered = 0 AND af.retry_count < ? THEN 1 ELSE 0 END) as failedCount
        FROM alerts_fired af
        JOIN alert_configs ac ON ac.id = af.alert_config_id
        WHERE ac.channel_type = ?
    `;
    const params: Array<number | string> = [MAX_RETRY_COUNT, MAX_RETRY_COUNT, channelType];
    
    if (days !== undefined && days > 0) {
        sql += ` AND af.fired_at >= datetime('now', ?)`;
        params.push(`-${days} days`);
    }

    const row = db.prepare(sql).get(...params) as any;

    if (!row) {
        return { totalAttempts: 0, deliveredCount: 0, failedCount: 0, abandonedCount: 0, successRate: 0 };
    }

    const total = row.totalAttempts || 0;
    const delivered = row.deliveredCount || 0;
    const successRate = total > 0 ? (delivered / total) * 100 : 0;

    return {
        totalAttempts: total,
        deliveredCount: delivered,
        failedCount: row.failedCount || 0,
        abandonedCount: row.abandonedCount || 0,
        successRate: successRate,
    };
}

// ---------------------------- Channel Accounts ----------------------------

export interface ChannelAccount {
    id: number;
    public_key: string;
    label: string | null;
    network: string;
    keypair_source: string | null;
    funded: boolean;
    balance_xlm: number | null;
    balance_checked_at: string | null;
    created_at: string;
}

export function insertChannelAccount(db: Database.Database, account: {
    public_key: string;
    label?: string;
    network: string;
}): void {
    db.prepare(`
        INSERT INTO channel_accounts (public_key, label, network)
        VALUES (@public_key, @label, @network)
    `).run({
        public_key: account.public_key,
        label: account.label ?? null,
        network: account.network,
    });
}

export function upsertChannelAccount(db: Database.Database, account: {
    public_key: string;
    keypair_source: string;
    network: string;
}): void {
    db.prepare(`
        INSERT INTO channel_accounts (public_key, keypair_source, network)
        VALUES (@public_key, @keypair_source, @network)
        ON CONFLICT(public_key) DO UPDATE SET
            keypair_source = @keypair_source,
            network = @network
    `).run(account);
}

export function getChannelAccounts(db: Database.Database, network: string): ChannelAccount[] {
    return db.prepare("SELECT * FROM channel_accounts WHERE network = ? ORDER BY id ASC")
        .all(network) as ChannelAccount[];
}

export function updateChannelBalance(db: Database.Database, publicKey: string, balanceXlm: number): void {
    db.prepare(`
        UPDATE channel_accounts
        SET balance_xlm = ?, balance_checked_at = datetime('now')
        WHERE public_key = ?
    `).run(balanceXlm, publicKey);
}

export function deleteChannelAccount(db: Database.Database, publicKey: string): void {
    db.prepare("DELETE FROM channel_accounts WHERE public_key = ?").run(publicKey);
}

export function markChannelFunded(db: Database.Database, publicKey: string): void {
    db.prepare("UPDATE channel_accounts SET funded = 1 WHERE public_key = ?").run(publicKey);
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
        ORDER BY snapshot_ledger DESC, id DESC
        LIMIT 1
    `).get(contractEntryId) as StateSnapshot | undefined;
}

// ---------------------------- Database Access Functions For Schema: StateChange ----------------------------
export function insertStateChange(db: Database.Database, change: {
    contract_entry_id: number;
    old_snapshot_id?: number;
    new_snapshot_id?: number;
    diff_type: StateChange["diff_type"];
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
    let sql = "SELECT * FROM state_changes WHERE contract_entry_id = ? ORDER BY detected_at_ledger DESC, id DESC";
    if (limit !== undefined) {
        if (limit < 0) {
            throw new Error("limit must be non-negative");
        }
        sql += " LIMIT ?";
        return db.prepare(sql).all(contractEntryId, limit) as StateChange[];
    }
    return db.prepare(sql).all(contractEntryId) as StateChange[];
}

export interface StateChangeHistoryRecord {
    changeId: number;
    contractEntryId: number;
    entryKeyXdr: string;
    entryType: string;
    entryLabel: string | null;
    diffType: "created" | "updated" | "deleted";
    diffJson: string;
    detectedAtLedger: number;
    createdAt: string;
    oldValueXdr: string | null;
    newValueXdr: string | null;
}

/**
 * Return a rich history view of state changes for a contract,
 * joining state_changes → contract_entries → state_snapshots.
 */
export function getStateChangeHistory(
    db: Database.Database,
    contractId: string,
    opts?: { limit?: number; entryKeyXdr?: string },
): StateChangeHistoryRecord[] {
    const limit = opts?.limit;
    const entryKeyXdr = opts?.entryKeyXdr;

    let sql = `
        SELECT
            sc.id              AS changeId,
            sc.contract_entry_id AS contractEntryId,
            ce.entry_key_xdr   AS entryKeyXdr,
            ce.entry_type      AS entryType,
            ce.label           AS entryLabel,
            sc.diff_type       AS diffType,
            sc.diff_json       AS diffJson,
            sc.detected_at_ledger AS detectedAtLedger,
            sc.created_at      AS createdAt,
            old_snap.value_xdr AS oldValueXdr,
            new_snap.value_xdr AS newValueXdr
        FROM state_changes sc
        JOIN contract_entries ce ON ce.id = sc.contract_entry_id
        LEFT JOIN state_snapshots old_snap ON old_snap.id = sc.old_snapshot_id
        LEFT JOIN state_snapshots new_snap ON new_snap.id = sc.new_snapshot_id
        WHERE ce.contract_id = ?
    `;

    const params: (string | number)[] = [contractId];

    if (entryKeyXdr) {
        sql += " AND ce.entry_key_xdr = ?";
        params.push(entryKeyXdr);
    }

    sql += " ORDER BY sc.detected_at_ledger DESC, sc.id DESC";

    if (limit !== undefined && limit >= 0) {
        sql += " LIMIT ?";
        params.push(limit);
    }

    return db.prepare(sql).all(...params) as StateChangeHistoryRecord[];
}

// ─── Resource Alert Configuration & History ──────────────────────────────────


export interface ResourceAlertConfig {
    id: number;
    contract_id: string;
    /** Any registered alert channel name (see src/alerts/registry.ts) — not a fixed enum. */
    channel_type: string;
    channel_target: string;
    cpu_limit: number;
    mem_limit: number;
    webhook_secret: string | null;
    created_at: Date;
}

export function insertResourceAlertConfig(db: Database.Database, config: {
    contract_id: string;
    channel_type: string;
    channel_target: string;
    cpu_limit: number;
    mem_limit: number;
    webhook_secret?: string;
}): void {
    db.prepare(`
        INSERT INTO resource_alert_configs (contract_id, channel_type, channel_target, cpu_limit, mem_limit, webhook_secret)
        VALUES (@contract_id, @channel_type, @channel_target, @cpu_limit, @mem_limit, @webhook_secret)
    `).run({
        contract_id: config.contract_id,
        channel_type: config.channel_type,
        channel_target: config.channel_target,
        cpu_limit: config.cpu_limit,
        mem_limit: config.mem_limit,
        webhook_secret: config.webhook_secret ?? null,
    });
}

export function getResourceAlertConfigsForContract(db: Database.Database, contractId: string): ResourceAlertConfig[] {
    return db.prepare("SELECT * FROM resource_alert_configs WHERE contract_id = ?").all(contractId) as ResourceAlertConfig[];
}

export function getResourceAlertConfigById(db: Database.Database, id: number): ResourceAlertConfig | undefined {
    return db.prepare("SELECT * FROM resource_alert_configs WHERE id = ?").get(id) as ResourceAlertConfig | undefined;
}

export function deleteResourceAlertConfig(db: Database.Database, id: number): void {
    db.prepare("DELETE FROM resource_alert_configs WHERE id = ?").run(id);
}

export function recordResourceAlertFired(db: Database.Database, alert: {
    resource_alert_config_id: number;
    resource_type: "cpu" | "memory";
    usage: number;
    limit: number;
    usage_percent: number;
    fired_at_ledger?: number;
}): number {
    const result = db.prepare(`
      INSERT INTO resource_alerts_fired (resource_alert_config_id, resource_type, usage, "limit", usage_percent, fired_at_ledger)
      VALUES (@resource_alert_config_id, @resource_type, @usage, @limit, @usage_percent, @fired_at_ledger)
    `).run({
      resource_alert_config_id: alert.resource_alert_config_id,
      resource_type: alert.resource_type,
      usage: alert.usage,
      limit: alert.limit,
      usage_percent: alert.usage_percent,
      fired_at_ledger: alert.fired_at_ledger ?? null,
    });
    return result.lastInsertRowid as number;
}

export interface ResourceUsageRecord {
    resourceType: "cpu" | "memory";
    usage: number;
    usagePercent: number;
    firedAt: string;
}

export function getResourceUsageHistory(db: Database.Database, contractId: string, days?: number): ResourceUsageRecord[] {
    if (days) {
        return db.prepare(`
            SELECT raf.resource_type AS resourceType,
                   raf.usage,
                   raf.usage_percent AS usagePercent,
                   raf.fired_at AS firedAt
            FROM resource_alerts_fired raf
            JOIN resource_alert_configs rac ON rac.id = raf.resource_alert_config_id
            WHERE rac.contract_id = ?
              AND raf.fired_at >= datetime('now', ?)
            ORDER BY raf.fired_at DESC
        `).all(contractId, `-${days} days`) as ResourceUsageRecord[];
    }

    return db.prepare(`
        SELECT raf.resource_type AS resourceType,
               raf.usage,
               raf.usage_percent AS usagePercent,
               raf.fired_at AS firedAt
        FROM resource_alerts_fired raf
        JOIN resource_alert_configs rac ON rac.id = raf.resource_alert_config_id
        WHERE rac.contract_id = ?
        ORDER BY raf.fired_at DESC
    `).all(contractId) as ResourceUsageRecord[];
}

export function getUndeliveredResourceAlerts(db: Database.Database, network: string): Array<{
    alertFiredId: number;
    resourceAlertConfigId: number;
    contractId: string;
    contractName: string | null;
    network: string;
    resourceType: "cpu" | "memory";
    usage: number;
    limit: number;
    usagePercent: number;
    /** Any registered alert channel name (see src/alerts/registry.ts) — not a fixed enum. */
    channelType: string;
    channelTarget: string;
    webhookSecret: string | null;
    retryCount: number;
    firedAtLedger: number | null;
}> {
    return db.prepare(`
        SELECT
            raf.id               AS alertFiredId,
            raf.resource_alert_config_id AS resourceAlertConfigId,
            c.id                 AS contractId,
            c.name               AS contractName,
            c.network,
            raf.resource_type    AS resourceType,
            raf.usage,
            raf."limit",
            raf.usage_percent    AS usagePercent,
            rac.channel_type     AS channelType,
            rac.channel_target   AS channelTarget,
            rac.webhook_secret   AS webhookSecret,
            raf.retry_count      AS retryCount,
            raf.fired_at_ledger  AS firedAtLedger
        FROM resource_alerts_fired raf
        JOIN resource_alert_configs rac ON rac.id = raf.resource_alert_config_id
        JOIN contracts c ON c.id = rac.contract_id
        WHERE c.network = ? AND raf.delivered = 0 AND raf.retry_count < ?
        ORDER BY raf.fired_at DESC
    `).all(network, MAX_RETRY_COUNT) as Array<{
        alertFiredId: number;
        resourceAlertConfigId: number;
        contractId: string;
        contractName: string | null;
        network: string;
        resourceType: "cpu" | "memory";
        usage: number;
        limit: number;
        usagePercent: number;
        /** Any registered alert channel name (see src/alerts/registry.ts) — not a fixed enum. */
    channelType: string;
        channelTarget: string;
        webhookSecret: string | null;
        retryCount: number;
        firedAtLedger: number | null;
    }>;
}

export function markResourceAlertDelivered(db: Database.Database, alertFiredId: number): void {
    db.prepare(`
        UPDATE resource_alerts_fired SET delivered = 1, delivered_at = datetime('now') WHERE id = ?
    `).run(alertFiredId);
}

export function incrementResourceAlertRetryCount(db: Database.Database, alertFiredId: number): void {
    db.prepare("UPDATE resource_alerts_fired SET retry_count = retry_count + 1 WHERE id = ?").run(alertFiredId);
}

export function hasUnresolvedResourceAlert(
  db: Database.Database,
  configId: number,
  resourceType: "cpu" | "memory",
  currentUsagePercent?: number,
): boolean {
  if (typeof currentUsagePercent === "undefined") {
    const result = db.prepare(`
      SELECT 1 FROM resource_alerts_fired
      WHERE resource_alert_config_id = ? AND resource_type = ? AND resolved = 0
      LIMIT 1
    `).get(configId, resourceType) as { 1: number } | undefined;
    return !!result;
  }

  // If we have a current usage percent, only consider an existing unresolved
  // alert to be blocking if its recorded usage_percent is greater than or
  // equal to the current usage (i.e., no increase). If the current usage
  // is higher, allow firing a new alert.
  const row = db.prepare(`
    SELECT usage_percent FROM resource_alerts_fired
    WHERE resource_alert_config_id = ? AND resource_type = ? AND resolved = 0
    ORDER BY fired_at DESC
    LIMIT 1
  `).get(configId, resourceType) as { usage_percent?: number } | undefined;

  if (!row || typeof row.usage_percent === "undefined") return false;
  return row.usage_percent >= currentUsagePercent;
}


// ─── Resource Usage Logs (issue #164) ────────────────────────────────────────

/**
 * A single resource-usage snapshot captured per Soroban transaction.
 * All fee columns are nullable because not every RPC response includes the
 * full fee breakdown.
 */
export interface ResourceUsageLog {
    id: number;
    contract_id: string;
    cpu_insns: number;
    mem_bytes: number;
    fee_instructions: number | null;
    fee_read_ledger_entries: number | null;
    fee_write_ledger_entries: number | null;
    fee_read_bytes: number | null;
    fee_write_bytes: number | null;
    fee_transaction_size: number | null;
    fee_historical_ledger: number | null;
    fee_rent_ledger: number | null;
    fee_refundable: number | null;
    recorded_at: string;
}

/**
 * Insert a new resource-usage log entry.
 *
 * @returns The auto-assigned row id of the inserted entry.
 */
export function insertResourceUsageLog(
    db: Database.Database,
    log: {
        contract_id: string;
        cpu_insns: number;
        mem_bytes: number;
        fee_instructions?: number | null;
        fee_read_ledger_entries?: number | null;
        fee_write_ledger_entries?: number | null;
        fee_read_bytes?: number | null;
        fee_write_bytes?: number | null;
        fee_transaction_size?: number | null;
        fee_historical_ledger?: number | null;
        fee_rent_ledger?: number | null;
        fee_refundable?: number | null;
        /** Optional ISO-8601 timestamp; defaults to CURRENT_TIMESTAMP when omitted. */
        recorded_at?: string;
    },
): number {
    const result = db.prepare(`
        INSERT INTO resource_usage_logs (
            contract_id,
            cpu_insns,
            mem_bytes,
            fee_instructions,
            fee_read_ledger_entries,
            fee_write_ledger_entries,
            fee_read_bytes,
            fee_write_bytes,
            fee_transaction_size,
            fee_historical_ledger,
            fee_rent_ledger,
            fee_refundable,
            recorded_at
        ) VALUES (
            @contract_id,
            @cpu_insns,
            @mem_bytes,
            @fee_instructions,
            @fee_read_ledger_entries,
            @fee_write_ledger_entries,
            @fee_read_bytes,
            @fee_write_bytes,
            @fee_transaction_size,
            @fee_historical_ledger,
            @fee_rent_ledger,
            @fee_refundable,
            COALESCE(@recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
    `).run({
        contract_id: log.contract_id,
        cpu_insns: log.cpu_insns,
        mem_bytes: log.mem_bytes,
        fee_instructions: log.fee_instructions ?? null,
        fee_read_ledger_entries: log.fee_read_ledger_entries ?? null,
        fee_write_ledger_entries: log.fee_write_ledger_entries ?? null,
        fee_read_bytes: log.fee_read_bytes ?? null,
        fee_write_bytes: log.fee_write_bytes ?? null,
        fee_transaction_size: log.fee_transaction_size ?? null,
        fee_historical_ledger: log.fee_historical_ledger ?? null,
        fee_rent_ledger: log.fee_rent_ledger ?? null,
        fee_refundable: log.fee_refundable ?? null,
        recorded_at: log.recorded_at ?? null,
    });

    return result.lastInsertRowid as number;
}

/**
 * Return resource-usage logs for a contract, newest first.
 *
 * @param options.limit   Maximum number of rows to return (must be ≥ 0).
 * @param options.since   ISO-8601 lower-bound for recorded_at (inclusive).
 */
export function getResourceUsageLogs(
    db: Database.Database,
    contractId: string,
    options: { limit?: number; since?: string } = {},
): ResourceUsageLog[] {
    const { limit, since } = options;

    if (limit !== undefined && limit < 0) {
        throw new Error("limit must be non-negative");
    }

    const conditions: string[] = ["contract_id = @contractId"];
    if (since !== undefined) {
        conditions.push("recorded_at >= @since");
    }

    const where = conditions.join(" AND ");
    const params: Record<string, unknown> = { contractId, since: since ?? null };

    let query = `
        SELECT *
        FROM resource_usage_logs
        WHERE ${where}
        ORDER BY recorded_at DESC, id DESC
    `;
    if (limit !== undefined) {
        query += ` LIMIT @limit`;
        params.limit = limit;
    }

    return db.prepare(query).all(params) as ResourceUsageLog[];
}

/**
 * Return the single most-recent resource-usage log for a contract,
 * or `undefined` if none exist.
 */
export function getLatestResourceUsageLog(
    db: Database.Database,
    contractId: string,
): ResourceUsageLog | undefined {
    return db.prepare(`
        SELECT *
        FROM resource_usage_logs
        WHERE contract_id = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1
    `).get(contractId) as ResourceUsageLog | undefined;
}

// ─── Contract Groups (issue #394) ────────────────────────────────────────────

/**
 * Create a new named group.
 *
 * @returns The auto-assigned row id of the new group.
 */
export function createGroup(
    db: Database.Database,
    group: { name: string; poll_interval_seconds?: number | null },
): number {
    const result = db.prepare(`
        INSERT INTO contract_groups (name, poll_interval_seconds)
        VALUES (@name, @poll_interval_seconds)
    `).run({ name: group.name, poll_interval_seconds: group.poll_interval_seconds ?? null });
    return result.lastInsertRowid as number;
}

/**
 * Set (or clear, with null) a group's default poll interval in seconds.
 * Consulted by resolvePollIntervalMs as a fallback tier between a
 * contract's own override and the global --interval flag (issue #400).
 */
export function setGroupPollInterval(
    db: Database.Database,
    groupId: number,
    pollIntervalSeconds: number | null,
): void {
    db.prepare(`
        UPDATE contract_groups SET poll_interval_seconds = ? WHERE id = ?
    `).run(pollIntervalSeconds, groupId);
}

/**
 * Add a contract to a group.
 * Idempotent — safe to call more than once (UNIQUE constraint).
 */
export function addContractToGroup(
    db: Database.Database,
    membership: { group_id: number; contract_id: string },
): void {
    db.prepare(`
        INSERT OR IGNORE INTO contract_group_members (group_id, contract_id)
        VALUES (@group_id, @contract_id)
    `).run(membership);
}

/**
 * Remove a contract from a group.
 * No-op if the membership does not exist.
 */
export function removeContractFromGroup(
    db: Database.Database,
    membership: { group_id: number; contract_id: string },
): void {
    db.prepare(`
        DELETE FROM contract_group_members
        WHERE group_id = @group_id AND contract_id = @contract_id
    `).run(membership);
}

/**
 * Return all contracts that belong to the given group.
 * Joins contract_group_members → contracts so the result includes full
 * contract rows.
 */
export function getContractsInGroup(
    db: Database.Database,
    groupId: number,
): Contract[] {
    return db.prepare(`
        SELECT c.*
        FROM contracts c
        JOIN contract_group_members cgm ON cgm.contract_id = c.id
        WHERE cgm.group_id = ?
        ORDER BY c.id ASC
    `).all(groupId) as Contract[];
}

/**
 * Return all groups that the given contract belongs to.
 */
export function getGroupsForContract(
    db: Database.Database,
    contractId: string,
): ContractGroup[] {
    return db.prepare(`
        SELECT cg.*
        FROM contract_groups cg
        JOIN contract_group_members cgm ON cgm.group_id = cg.id
        WHERE cgm.contract_id = ?
        ORDER BY cg.name ASC
    `).all(contractId) as ContractGroup[];
}

/**
 * Look up a group by its unique name.
 */
export function getGroupByName(db: Database.Database, name: string): ContractGroup | undefined {
    return db.prepare("SELECT * FROM contract_groups WHERE name = ?").get(name) as ContractGroup | undefined;
}

/**
 * Return every contract group, ordered by name.
 */
export function getAllGroups(db: Database.Database): ContractGroup[] {
    return db.prepare("SELECT * FROM contract_groups ORDER BY name ASC").all() as ContractGroup[];
}

/**
 * Insert an alert config for every contract whose `tags` column contains the
 * given tag (comma-separated list). A tag match is performed as an exact
 * word match — splitting on commas and trimming whitespace — so `"defi"` does
 * not accidentally match `"defi-pro"`.
 *
 * All inserts are wrapped in a single SQLite transaction: either every row is
 * written or none are (atomic bulk operation).
 *
 * @param db       - The SQLite database connection.
 * @param tag      - The tag string to match against `contracts.tags`.
 * @param config   - Alert channel/threshold settings applied to each matching contract.
 * @returns        The number of alert_configs rows inserted.
 */
export function insertAlertConfigBulk(
    db: Database.Database,
    tag: string,
    config: {
        channel_type: string;
        channel_target: string;
        threshold_ledgers: number;
        webhook_secret?: string;
    },
): number {
    const contracts = (
        db.prepare("SELECT id, tags FROM contracts").all() as Array<{
            id: string;
            tags: string | null;
        }>
    ).filter((c) => {
        if (!c.tags) return false;
        return c.tags
            .split(",")
            .map((t) => t.trim())
            .includes(tag);
    });

    if (contracts.length === 0) return 0;

    const insert = db.prepare(`
        INSERT INTO alert_configs (contract_id, channel_type, channel_target, threshold_ledgers, webhook_secret)
        VALUES (@contract_id, @channel_type, @channel_target, @threshold_ledgers, @webhook_secret)
    `);

    const runAll = db.transaction((rows: Array<{ id: string }>) => {
        for (const row of rows) {
            insert.run({
                contract_id: row.id,
                channel_type: config.channel_type,
                channel_target: config.channel_target,
                threshold_ledgers: config.threshold_ledgers,
                webhook_secret: config.webhook_secret ?? null,
            });
        }
    });

    runAll(contracts);
    return contracts.length;
}

// ─── Digest Configs (issue #399) ─────────────────────────────────────────────

export interface DigestConfig {
    id: number;
    network: string;
    /** Any registered alert channel name (see src/alerts/registry.ts) — not a fixed enum. */
    channel_type: string;
    channel_target: string;
    /** Delivery interval in milliseconds. */
    interval_ms: number;
    webhook_secret: string | null;
    /** 1 = enabled, 0 = disabled. */
    enabled: number;
    created_at: string;
}

/**
 * Insert a new digest configuration row.
 * Returns the auto-generated row id.
 */
export function insertDigestConfig(
    db: Database.Database,
    config: {
        network: string;
        channel_type: string;
        channel_target: string;
        interval_ms: number;
        webhook_secret?: string | null;
    },
): number {
    const info = db
        .prepare(
            `INSERT INTO digest_configs (network, channel_type, channel_target, interval_ms, webhook_secret)
             VALUES (@network, @channel_type, @channel_target, @interval_ms, @webhook_secret)`,
        )
        .run({
            network: config.network,
            channel_type: config.channel_type,
            channel_target: config.channel_target,
            interval_ms: config.interval_ms,
            webhook_secret: config.webhook_secret ?? null,
        });
    return info.lastInsertRowid as number;
}

/**
 * Return all enabled digest configs for the given network.
 */
export function getDigestConfigs(
    db: Database.Database,
    network: string,
): DigestConfig[] {
    return db
        .prepare(
            `SELECT * FROM digest_configs WHERE network = ? AND enabled = 1 ORDER BY id ASC`,
        )
        .all(network) as DigestConfig[];
}

// ─── TTL Samples (issue #492 — predictive scheduling) ────────────────────────

/**
 * Maximum number of TTL samples retained per contract entry.
 * Older samples beyond this limit are pruned on each insert.
 */
export const MAX_TTL_SAMPLES = 10;

export interface TTLSampleRow {
    id: number;
    entry_id: number;
    sampledAtLedger: number;
    liveUntilLedger: number;
    recorded_at: string;
}

/**
 * Persist a single TTL reading for a contract entry.
 * Call `pruneOldTTLSamples` after inserting to keep the window bounded.
 */
export function insertTTLSample(
    db: Database.Database,
    entryId: number,
    sampledAtLedger: number,
    liveUntilLedger: number,
): void {
    db.prepare(`
        INSERT INTO ttl_samples (entry_id, sampled_at_ledger, live_until_ledger)
        VALUES (?, ?, ?)
    `).run(entryId, sampledAtLedger, liveUntilLedger);
}

/**
 * Return up to `limit` TTL samples for an entry, newest first.
 * Defaults to MAX_TTL_SAMPLES.
 */
export function getTTLSamples(
    db: Database.Database,
    entryId: number,
    limit = MAX_TTL_SAMPLES,
): Array<{ sampledAtLedger: number; liveUntilLedger: number }> {
    return db.prepare(`
        SELECT sampled_at_ledger AS sampledAtLedger,
               live_until_ledger AS liveUntilLedger
        FROM ttl_samples
        WHERE entry_id = ?
        ORDER BY sampled_at_ledger DESC
        LIMIT ?
    `).all(entryId, limit) as Array<{ sampledAtLedger: number; liveUntilLedger: number }>;
}

/**
 * Delete samples beyond MAX_TTL_SAMPLES for the given entry, keeping the
 * newest MAX_TTL_SAMPLES rows.  Call this after every insert.
 */
export function pruneOldTTLSamples(
    db: Database.Database,
    entryId: number,
    keep = MAX_TTL_SAMPLES,
): void {
    db.prepare(`
        DELETE FROM ttl_samples
        WHERE entry_id = ?
          AND id NOT IN (
              SELECT id FROM ttl_samples
              WHERE entry_id = ?
              ORDER BY sampled_at_ledger DESC
              LIMIT ?
          )
    `).run(entryId, entryId, keep);
}
