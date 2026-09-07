import type Database from "better-sqlite3";
import { StellarRpcClient } from "../rpc/client.js";
import {
    getAllContracts,
    getContract,
    getEntriesForContract,
    getExtensionPolicy,
    getChannelAccounts,
    recordExtension,
    upsertEntry,
    updateLastCheckedLedger,
    getAverageResourceUsage,
    getBudget,
    addBudgetSpent,
    countExtensionsInLastHour,
    getAlertConfigsForContract,
    getExtensionHistory,
    getEffectivePolicy,
    getTTLSamples,
    type EntryType,

} from "../db/repositories.js";
import { ChannelAccountPool } from "./channels.js";
import { getLogger } from "../logging/index.js";
import { formatSecretKey } from "../utils/formatting.js";
import { VaultResolver } from "./vault.js";
import { loadConfig } from "../utils/config.js";
import { buildBudgetExhaustedAlertEvent, buildAlertEvent } from "../alerts/types.js";
import { deliverSingleAlert } from "../alerts/dispatcher.js";
import { SimulationCacheManager, computeFootprintHash } from "./simulation_cache.js";
import { computeDecayRate, projectCrossingLedger } from "./predictive.js";

const logger = getLogger().child({ component: "Extension" });

// Shared across all contracts to minimize redundant RPC simulateTransaction
// calls during auto-extension cycles (issue #501).
const simulationCache = new SimulationCacheManager();

/**
 * Clear the global simulation cache. Used for testing and when contract
 * state changes significantly.
 * @internal
 */
export function clearSimulationCache(): void {
    simulationCache.clearAll();
}


// ─── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Maximum number of auto-extension transactions allowed per contract per hour.
 * Prevents runaway fee submissions under extreme network load (issue #142).
 */
export const HOURLY_RATE_LIMIT = 5;

/**
 * Minimum XLM balance a channel account must hold before Sorokeep will submit
 * an extension transaction through it. Covers the base reserve (1 XLM) plus
 * a safety margin for transaction fees. Accounts below this threshold are
 * skipped and an alert is fired rather than attempting a failing transaction
 * (issue #504).
 */
export const MINIMUM_BALANCE_XLM = 5;

/**
 * Minimum time (in milliseconds) that must pass between two consecutive
 * extensions of the same contract entry. Prevents the same entry being
 * extended twice in quick succession when the threshold is very tight
 * relative to the target TTL (issue #510).
 *
 * Default 5 minutes — slightly below the typical polling interval so it
 * does not interfere with normal operation.
 */
export const EXTENSION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Check whether the given contract has reached its hourly auto-extension rate limit.
 *
 * Queries `extension_history` for records within the last 60 minutes and
 * compares the count against `limit` (default: HOURLY_RATE_LIMIT).
 *
 * @param db - The SQLite database connection.
 * @param contractId - The contract to check.
 * @param limit - Maximum allowed extensions per hour (defaults to HOURLY_RATE_LIMIT).
 * @returns `true` when the contract is rate-limited; `false` otherwise.
 */
export function isRateLimited(
    db: import("better-sqlite3").Database,
    contractId: string,
    limit = HOURLY_RATE_LIMIT,
): boolean {
    const count = countExtensionsInLastHour(db, contractId);
    return count >= limit;
}

// ─── Public contract ──────────────────────────────────────────────────────────


export interface ExtensionResult {
    success: boolean;
    contractId: string;
    entriesExtended: number;
    txHash?: string;
    ledger?: number;
    error?: string;
    /** Estimated fee in stroops (from simulation, before submission). */
    estimatedFee?: number;
    /** Actual fee charged in stroops (from submitted transaction result). */
    feeCharged?: number;
    /** CPU instructions consumed by the transaction. */

    cpuInsns?: number;
    memBytes?: number;
    /** Read footprint size in bytes. */
    readBytes?: number;
    /** Write footprint size in bytes. */
    writeBytes?: number;
    /** Whether resource usage spiked. */

    isAnomaly?: boolean;
    anomalyDetails?: string;
}

export interface AutoExtensionResult {
    contractsChecked: number;
    contractsExtended: number;
    entriesExtended: number;
    errors: string[];
    extensions: Array<{
        contractId: string;
        txHash: string;
        entriesExtended: number;
        ledger: number;
        isAnomaly?: boolean;
        anomalyDetails?: string;
    }>;
}

/**
 * Options for predictive TTL extension scheduling (issue #492).
 * When `predictiveCycles` > 0, entries whose projected crossing ledger falls
 * within the next `predictiveCycles` daemon cycles are extended proactively,
 * even if their current TTL is still above the reactive threshold.
 */
export interface PredictiveOptions {
    /**
     * Number of daemon cycles ahead to project TTL crossing.
     * 0 or undefined disables predictive mode.
     */
    predictiveCycles?: number;
    /**
     * Approximate ledger interval between daemon cycles.
     * Defaults to 60 ledgers (~5 minutes at 5 s/ledger).
     */
    ledgersPerCycle?: number;
}

export interface RestoreResult {
    success: boolean;
    contractId: string;
    entriesRestored: number;
    txHash?: string;
    ledger?: number;
    error?: string;
    /** Estimated fee in stroops (from simulation, before submission). */
    estimatedFee?: number;
    cpuInsns?: number;
    memBytes?: number;
    minResourceFee?: number;
    /** Fee charged in stroops. */
    feeCharged?: number;

}

export async function simulateExtension(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    extendToLedgers: number,
    sourcePublicKey: string,
    rpcUrl?: string,
): Promise<ExtensionResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesExtended: 0, error: "Contract not found" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    const footprintHash = computeFootprintHash(entryKeyXdrs);
    const wasmHash = contract.wasm_hash || "unknown";

    let sim;
    try {
        sim = await simulationCache.getSimulation(
            footprintHash,
            wasmHash,
            contractId,
            async () => {
                logger.debug(`Cache miss for ${contractId} — running fresh simulation`);
                return await client.simulateExtension(entryKeyXdrs, extendToLedgers, sourcePublicKey);
            },
        );
    } catch (err: any) {
        logger.warn(`Simulation warning for ${contractId}: ${err.message}`);
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            error: err.message,
        };
    }

    return {
        success: true,
        contractId,
        entriesExtended: entryKeyXdrs.length,
        estimatedFee: sim.minResourceFee,
        cpuInsns: sim.cpuInstructions,
        memBytes: sim.memoryBytes,
        readBytes: sim.readBytes,
        writeBytes: sim.writeBytes,
    };
}

export async function extendEntries(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    extendToLedgers: number,
    secretKey: string,
    rpcUrl?: string,
    sponsorSecret?: string,
): Promise<ExtensionResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesExtended: 0, error: "Contract not found" };
    }

    if (entryKeyXdrs.length === 0) {
        return { success: false, contractId, entriesExtended: 0, error: "No entries to extend" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    logger.info(
        `Extending ${entryKeyXdrs.length} entries for ${contractId} to ${extendToLedgers} ledgers`,
    );

    const resolvedSponsorSecret = sponsorSecret ? await resolveSecretKey(sponsorSecret) : undefined;
    if (sponsorSecret && !resolvedSponsorSecret) {
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            error: `Failed to resolve sponsor secret key from environment variable: ${sponsorSecret}`,
        };
    }

    let txResult;
    try {
        txResult = resolvedSponsorSecret
            ? await client.submitExtensionWithFeeBump(
                entryKeyXdrs,
                extendToLedgers,
                secretKey,
                resolvedSponsorSecret,
            )
            : await client.submitExtension(entryKeyXdrs, extendToLedgers, secretKey);
    } catch (err: any) {
        logger.warn(`Simulation warning for ${contractId}: ${err.message}`);
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            error: err.message,
        };
    }

    if (!txResult.success) {
        logger.error(`Extension failed for ${contractId}: ${txResult.error}`);
        return {
            success: false,
            contractId,
            entriesExtended: 0,
            txHash: txResult.txHash || undefined,
            error: txResult.error,
        };
    }

    let isAnomaly = false;
    let anomalyDetails: string | undefined = undefined;

    if (txResult.cpuInsns && txResult.memBytes) {
        const baseline = getAverageResourceUsage(db, contractId, 10);
        if (baseline && baseline.avg_cpu_insns > 0 && baseline.avg_mem_bytes > 0) {
            const cpuRatio = txResult.cpuInsns / baseline.avg_cpu_insns;
            const memRatio = txResult.memBytes / baseline.avg_mem_bytes;
            if (cpuRatio >= 2.0 || memRatio >= 2.0) {
                isAnomaly = true;
                const details = [];
                if (cpuRatio >= 2.0) details.push(`CPU usage is ${cpuRatio.toFixed(2)}x baseline`);
                if (memRatio >= 2.0) details.push(`Memory usage is ${memRatio.toFixed(2)}x baseline`);
                anomalyDetails = `Resource anomaly detected: ` + details.join(", ");
            }
        }
    }

    const freshTTLs = await client.getEntryTTLs(entryKeyXdrs);
    const entries = getEntriesForContract(db, contractId);
    const entryMap = new Map(entries.map(e => [e.entry_key_xdr, e]));

    const updateDb = db.transaction(() => {
        for (const freshEntry of freshTTLs.entries) {
            const dbEntry = entryMap.get(freshEntry.entryKeyXdr);
            if (!dbEntry) continue;

            const oldTTL = dbEntry.live_until_ledger
                ? dbEntry.live_until_ledger - freshTTLs.latestLedger
                : 0;

            recordExtension(db, {
                contract_id: contractId,
                contract_entry_id: dbEntry.id,
                old_ttl_ledgers: Math.max(0, oldTTL),
                new_ttl_ledgers: freshEntry.remainingTTL,
                tx_hash: txResult.txHash,
                cpu_insns: txResult.cpuInsns,
                mem_bytes: txResult.memBytes,
                is_anomaly: isAnomaly,
                executed_at_ledger: freshTTLs.latestLedger,
            });

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: freshEntry.entryKeyXdr,
                entry_type: dbEntry.entry_type,
                label: dbEntry.label ?? undefined,
                live_until_ledger: freshEntry.liveUntilLedgerSeq,
                last_modified_ledger: freshEntry.lastModifiedLedgerSeq,
                discovery_source: dbEntry.discovery_source,
            });
        }

        updateLastCheckedLedger(db, contractId, freshTTLs.latestLedger);
    });
    updateDb();

    // The entries' TTLs just changed, so any cached simulation is now stale.
    simulationCache.invalidate(computeFootprintHash(entryKeyXdrs));

    return {
        success: true,
        contractId,
        entriesExtended: entryKeyXdrs.length,
        txHash: txResult.txHash,
        ledger: txResult.ledger,
        feeCharged: txResult.feeCharged,
        cpuInsns: txResult.cpuInsns,
        memBytes: txResult.memBytes,
        isAnomaly,
        anomalyDetails,
    };
}

export async function runAutoExtensions(
    db: Database.Database,
    network: string,
    rpcUrl?: string,
    sponsorSecret?: string,
    predictiveOpts?: PredictiveOptions,
): Promise<AutoExtensionResult> {
    const result: AutoExtensionResult = {
        contractsChecked: 0,
        contractsExtended: 0,
        entriesExtended: 0,
        errors: [],
        extensions: [],
    };

    const contracts = getAllContracts(db).filter(c => c.network === network);

    const eligibleContracts = contracts.filter(c => {
        const p = getExtensionPolicy(db, c.id);
        return p && p.enabled;
    });

    if (eligibleContracts.length === 0) return result;

    const client = new StellarRpcClient(network, rpcUrl);
    const latestLedger = await client.getCurrentLedger();

    const channelAccounts = getChannelAccounts(db, network);
    const pool = channelAccounts.length > 0
        ? new ChannelAccountPool(db, network)
        : null;

    result.contractsChecked = eligibleContracts.length;

    const extJitterStr = process.env.EXTENSION_JITTER_MS;
    const extensionJitterMs = extJitterStr ? parseInt(extJitterStr, 10) : 0;
    
    const eligibleTasks = [];
    for (const contract of eligibleContracts) {
        const policy = getExtensionPolicy(db, contract.id)!;
        const entries = getEntriesForContract(db, contract.id);
        const needsExtension = entries.filter(e => {
            if (!e.live_until_ledger) return false;
            // Per-entry-type policies (issue #491): an override supplies its
            // own extend_when_below_ledgers threshold; entries without an
            // override fall back to the contract-level policy unchanged.
            const effectivePolicy = getEffectivePolicy(db, contract.id, e.entry_type as EntryType) ?? policy;
            const remaining = e.live_until_ledger - latestLedger;

            // Reactive path: TTL already below threshold.
            if (remaining >= 0 && remaining < effectivePolicy.extend_when_below_ledgers) return true;

            // Predictive path (opt-in, issue #492): trigger early when the
            // decay-rate projection crosses the threshold within the next
            // N daemon cycles, even though the current TTL is still above it.
            const cycles = predictiveOpts?.predictiveCycles ?? policy.predictive_cycles ?? 0;
            if (cycles > 0 && remaining >= effectivePolicy.extend_when_below_ledgers) {
                const ledgersPerCycle = predictiveOpts?.ledgersPerCycle ?? 60;
                const horizonLedgers = latestLedger + cycles * ledgersPerCycle;

                const samples = getTTLSamples(db, e.id);
                const decayRate = computeDecayRate(samples);
                const projectedCrossing = projectCrossingLedger(
                    decayRate,
                    remaining,
                    effectivePolicy.extend_when_below_ledgers,
                    latestLedger,
                );

                if (projectedCrossing !== null && projectedCrossing <= horizonLedgers) {
                    logger.info(
                        `Predictive extension triggered for ${e.entry_key_xdr} ` +
                        `(contract ${contract.id}): projected crossing at ledger ${projectedCrossing}, ` +
                        `horizon ${horizonLedgers}`,
                    );
                    return true;
                }
            }

            return false;
        });

        if (needsExtension.length > 0) {
            eligibleTasks.push({ contract, policy, needsExtension });
        }
    }

    await Promise.all(eligibleTasks.map(async ({ contract, policy, needsExtension }) => {
        if (extensionJitterMs > 0 && eligibleTasks.length > 1) {
            const delay = Math.floor(Math.random() * extensionJitterMs);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        try {
            // ── Rate limit check (issue #142) ────────────────────────────────
            // Block auto-extension if the contract has already hit the maximum
            // number of extension transactions allowed per hour.
            if (isRateLimited(db, contract.id)) {
                const count = countExtensionsInLastHour(db, contract.id);
                const msg = `Contract ${contract.id}: rate limit reached — ${count}/${HOURLY_RATE_LIMIT} extensions in the last hour. Skipping.`;
                logger.warn(msg);
                result.errors.push(msg);
                return;
            }

            // ── Cooldown check per entry (issue #510) ──────────────────────
            // Filter out entries that were extended within the cooldown window
            // to prevent redundant back-to-back extensions of the same entry.
            const recentHistory = getExtensionHistory(db, contract.id, 1);
            const lastExtendedAt = new Map<number, Date>();
            for (const record of recentHistory) {
                const entryId = record.contract_entry_id;
                // executed_at is stored as UTC (SQLite CURRENT_TIMESTAMP); append
                // "Z" so the timestamp is parsed as UTC regardless of the host
                // machine's timezone.
                const executedAt = new Date(record.executed_at + "Z");
                const existing = lastExtendedAt.get(entryId);
                if (!existing || executedAt > existing) {
                    lastExtendedAt.set(entryId, executedAt);
                }
            }

            const cooldownEligible = needsExtension.filter(e => {
                const lastExt = lastExtendedAt.get(e.id);
                if (!lastExt) return true; // never extended → eligible
                const elapsed = Date.now() - lastExt.getTime();
                if (elapsed < EXTENSION_COOLDOWN_MS) {
                    logger.info(
                        `Entry ${e.entry_key_xdr} for ${contract.id} was extended ` +
                        `${Math.round(elapsed / 1000)}s ago — skipping (cooldown: ${EXTENSION_COOLDOWN_MS / 1000}s)`,
                    );
                    return false;
                }
                return true;
            });

            if (cooldownEligible.length === 0) {
                logger.info(
                    `All ${needsExtension.length} entries for ${contract.id} are within cooldown — skipping`,
                );
                return;
            }

            // Resolve secret key: prefer channel pool, fall back to policy keypair
            let secretKey: string | null = null;
            let slot: import("./channels.js").ChannelSlot | null = null;

            if (pool) {
                slot = await pool.acquire();
                secretKey = await resolveSecretKey(slot.keypairSource);
                if (!secretKey) {
                    pool.release(slot.publicKey);
                    slot = null;
                }
            }

            if (!secretKey) {
                secretKey = await resolveSecretKey(policy.keypair_source);
            }

            if (!secretKey) {
                result.errors.push(
                    `Contract ${contract.id}: Cannot resolve keypair from source "${pool ? "channel pool" : formatSecretKey(policy.keypair_source)}"`,
                );
                return;
            }

            // ── Minimum-balance check (issue #504) ──────────────────────────
            // If using a channel account, verify it has enough XLM to cover the
            // transaction fee and base reserve before attempting submission.
            if (slot) {
                const accounts = getChannelAccounts(db, network);
                const channelAccount = accounts.find(a => a.public_key === slot!.publicKey);
                const balance = channelAccount?.balance_xlm;

                if (balance === null || balance === undefined) {
                    const msg = `Contract ${contract.id}: Channel account ${slot.publicKey} balance is unknown — skipping extension. Run 'sorokeep channels list' to refresh balances.`;
                    logger.warn(msg);
                    result.errors.push(msg);
                    pool!.release(slot.publicKey);
                    return;
                }

                if (balance < MINIMUM_BALANCE_XLM) {
                    const msg = `Contract ${contract.id}: Channel account ${slot.publicKey} balance ${balance} XLM is below minimum ${MINIMUM_BALANCE_XLM} XLM — skipping extension.`;
                    logger.warn(msg);
                    result.errors.push(msg);

                    // Fire an alert through the contract's configured channels,
                    // using the first entry that needed extension for context.
                    const sampleEntry = needsExtension[0]!;
                    const contractRecord = getContract(db, contract.id);
                    const alertConfigs = getAlertConfigsForContract(db, contract.id);
                    for (const config of alertConfigs) {
                        const event = buildAlertEvent({
                            type: "threshold_crossed",
                            contractId: contract.id,
                            contractName: contractRecord?.name ?? null,
                            network,
                            entryKeyXdr: sampleEntry.entry_key_xdr,
                            entryType: sampleEntry.entry_type,
                            entryLabel: sampleEntry.label,
                            configuredLedgers: MINIMUM_BALANCE_XLM,
                            remainingTTL: sampleEntry.live_until_ledger
                                ? Math.max(0, sampleEntry.live_until_ledger - latestLedger)
                                : 0,
                            firedAtLedger: latestLedger,
                        });
                        deliverSingleAlert(
                            config.channel_type,
                            config.channel_target,
                            event,
                            config.webhook_secret,
                        ).catch((err: unknown) => {
                            logger.warn(
                                `Low-balance alert delivery failed for channel ${config.channel_type}: ${err instanceof Error ? err.message : String(err)}`,
                            );
                        });
                    }

                    pool!.release(slot.publicKey);
                    return;
                }
            }

            // Group cooldown-eligible entries by their effective target TTL
            // (issue #491's per-entry-type overrides). ExtendFootprintTTLOp
            // sets one new TTL for an entire batch of keys, so entries whose
            // effective policy resolves to different target_ttl_ledgers
            // values cannot share a single extension transaction.
            const groupsByTarget = new Map<number, typeof cooldownEligible>();
            for (const entry of cooldownEligible) {
                const effectivePolicy = getEffectivePolicy(db, contract.id, entry.entry_type as EntryType) ?? policy;
                const target = effectivePolicy.target_ttl_ledgers;
                const group = groupsByTarget.get(target) ?? [];
                group.push(entry);
                groupsByTarget.set(target, group);
            }

            try {
            for (const [targetTtlLedgers, groupEntries] of groupsByTarget) {
            const entryKeys = groupEntries.map(e => e.entry_key_xdr);

            logger.info(
                `Auto-extending ${entryKeys.length} entries for ${contract.id} ` +
                `(target ${targetTtlLedgers})`,
            );

            {
                const billingCycle = new Date().toISOString().slice(0, 7);

                // Pool membership takes precedence over the contract's individual
                // budget (issue #407). Roll the pool over to the current billing
                // cycle if it's stale, atomically with the membership lookup.
                const sharedBudget = db.transaction(() => {
                    const assigned = db.prepare(`
                        SELECT p.id, p.name, p.monthly_limit_xlm, p.billing_cycle, p.spent_xlm
                        FROM shared_budget_pools p
                        JOIN shared_budget_pool_contracts pc ON pc.pool_id = p.id
                        WHERE pc.contract_id = ?
                    `).get(contract.id) as {
                        id: number;
                        name: string;
                        monthly_limit_xlm: number;
                        billing_cycle: string;
                        spent_xlm: number;
                    } | undefined;
                    if (assigned && assigned.billing_cycle !== billingCycle) {
                        db.prepare(`
                            UPDATE shared_budget_pools
                            SET billing_cycle = ?, spent_xlm = 0, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `).run(billingCycle, assigned.id);
                        assigned.billing_cycle = billingCycle;
                        assigned.spent_xlm = 0;
                    }
                    return assigned;
                })();
                const budget = sharedBudget ? undefined : getBudget(db, contract.id, billingCycle);
                let estimatedFeeXlm = 0;
                let reservedPoolSpend = 0;

                if (sharedBudget || budget || policy.max_fee_stroops != null) {
                    const { Keypair } = await import("@stellar/stellar-sdk");
                    const pubKey = Keypair.fromSecret(secretKey).publicKey();
                    const simResult = await simulateExtension(db, contract.id, entryKeys, targetTtlLedgers, pubKey, rpcUrl);

                    if (!simResult.success) {
                        throw new Error(`Simulation failed: ${simResult.error}`);
                    }

                    estimatedFeeXlm = (simResult.estimatedFee || 0) / 10000000;

                    // Hard per-transaction fee ceiling (issue #420) — an
                    // independent safety net from the monthly budget checks
                    // below. Blocks submission outright if the RPC's fee
                    // estimate is anomalously high (bad estimate, misconfigured
                    // node, or a network fee spike).
                    if (policy.max_fee_stroops != null && (simResult.estimatedFee || 0) > policy.max_fee_stroops) {
                        throw new Error(
                            `Estimated fee (${simResult.estimatedFee} stroops) exceeds max fee ceiling (${policy.max_fee_stroops} stroops)`,
                        );
                    }

                    if (sharedBudget) {
                        // Atomic reserve-if-under-limit: the WHERE clause re-checks
                        // spent_xlm against monthly_limit_xlm in the same statement,
                        // so concurrent contracts sharing a pool can't both slip
                        // past the cap between check and increment.
                        const reservation = db.prepare(`
                            UPDATE shared_budget_pools
                            SET spent_xlm = spent_xlm + ?, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ? AND billing_cycle = ?
                              AND spent_xlm + ? <= monthly_limit_xlm
                        `).run(estimatedFeeXlm, sharedBudget.id, billingCycle, estimatedFeeXlm);

                        if (reservation.changes === 0) {
                            const current = db.prepare(`SELECT spent_xlm FROM shared_budget_pools WHERE id = ?`)
                                .get(sharedBudget.id) as { spent_xlm: number };
                            const budgetEvent = buildBudgetExhaustedAlertEvent({
                                contractId: contract.id,
                                contractName: contract.name,
                                network,
                                billingCycle,
                                limitXlm: sharedBudget.monthly_limit_xlm,
                                spentXlm: current.spent_xlm,
                                estimatedFeeXlm,
                            });
                            for (const cfg of getAlertConfigsForContract(db, contract.id)) {
                                deliverSingleAlert(cfg.channel_type, cfg.channel_target, budgetEvent, cfg.webhook_secret)
                                    .catch((err: unknown) => {
                                        logger.warn(
                                            `Budget-exhausted alert delivery failed for config ${cfg.id}: ${err instanceof Error ? err.message : String(err)}`,
                                        );
                                    });
                            }
                            throw new Error(`shared budget pool "${sharedBudget.name}" limit exceeded. Estimated cost: ${estimatedFeeXlm} XLM, Remaining: ${sharedBudget.monthly_limit_xlm - current.spent_xlm} XLM`);
                        }
                        reservedPoolSpend = estimatedFeeXlm;
                    } else if (budget && budget.spent_xlm + estimatedFeeXlm > budget.limit_xlm) {
                        const budgetEvent = buildBudgetExhaustedAlertEvent({
                            contractId: contract.id,
                            contractName: contract.name,
                            network,
                            billingCycle,
                            limitXlm: budget.limit_xlm,
                            spentXlm: budget.spent_xlm,
                            estimatedFeeXlm,
                        });
                        for (const cfg of getAlertConfigsForContract(db, contract.id)) {
                            deliverSingleAlert(cfg.channel_type, cfg.channel_target, budgetEvent, cfg.webhook_secret)
                                .catch((err: unknown) => {
                                    logger.warn(
                                        `Budget-exhausted alert delivery failed for config ${cfg.id}: ${err instanceof Error ? err.message : String(err)}`,
                                    );
                                });
                        }
                        throw new Error(`budget limit exceeded. Estimated cost: ${estimatedFeeXlm} XLM, Remaining: ${budget.limit_xlm - budget.spent_xlm} XLM`);
                    }
                }

                const extResult = await extendEntries(
                    db,
                    contract.id,
                    entryKeys,
                    targetTtlLedgers,
                    secretKey,
                    rpcUrl,
                    sponsorSecret,
                );

                if (extResult.success) {
                    const actualFeeXlm = extResult.feeCharged !== undefined ? extResult.feeCharged / 10000000 : estimatedFeeXlm;

                    if (sharedBudget && reservedPoolSpend > 0) {
                        // True up the reservation to the actual charged fee.
                        db.prepare(`
                            UPDATE shared_budget_pools
                            SET spent_xlm = spent_xlm + ?, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ? AND billing_cycle = ?
                        `).run(actualFeeXlm - reservedPoolSpend, sharedBudget.id, billingCycle);
                        reservedPoolSpend = 0;
                    } else if (budget && estimatedFeeXlm > 0) {
                        addBudgetSpent(db, contract.id, billingCycle, actualFeeXlm);
                    }

                    if (!extResult.txHash || extResult.ledger == null) {
                        result.errors.push(
                            `Contract ${contract.id}: Extension succeeded but RPC returned no txHash or ledger`,
                        );
                    } else {
                        result.contractsExtended++;
                        result.entriesExtended += extResult.entriesExtended;
                        result.extensions.push({
                            contractId: contract.id,
                            txHash: extResult.txHash,
                            entriesExtended: extResult.entriesExtended,
                            ledger: extResult.ledger,
                            isAnomaly: extResult.isAnomaly,
                            anomalyDetails: extResult.anomalyDetails,
                        });
                    }
                } else {
                    if (sharedBudget && reservedPoolSpend > 0) {
                        // Extension failed after the fee was reserved — give it back.
                        db.prepare(`
                            UPDATE shared_budget_pools
                            SET spent_xlm = MAX(0, spent_xlm - ?), updated_at = CURRENT_TIMESTAMP
                            WHERE id = ? AND billing_cycle = ?
                        `).run(reservedPoolSpend, sharedBudget.id, billingCycle);
                    }
                    result.errors.push(
                        `Contract ${contract.id}: Extension failed — ${extResult.error}`,
                    );
                }
            }
            }
            } finally {
                if (slot && pool) pool.release(slot.publicKey);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result.errors.push(`Contract ${contract.id}: ${message}`);
            logger.error(`Auto-extension error for ${contract.id}: ${message}`, err);
        }
    }));

    return result;
}

export async function simulateRestore(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    sourcePublicKey: string,
    rpcUrl?: string,
): Promise<RestoreResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesRestored: 0, error: "Contract not found" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);
    const sim = await client.simulateRestore(entryKeyXdrs, sourcePublicKey);

    if (!sim.success) {
        return { success: false, contractId, entriesRestored: 0, error: sim.error };
    }

    return {
        success: true,
        contractId,
        entriesRestored: entryKeyXdrs.length,
        estimatedFee: sim.minResourceFee,
    };
}

export async function restoreEntries(
    db: Database.Database,
    contractId: string,
    entryKeyXdrs: string[],
    secretKey: string,
    rpcUrl?: string,
): Promise<RestoreResult> {
    const contract = getContract(db, contractId);
    if (!contract) {
        return { success: false, contractId, entriesRestored: 0, error: "Contract not found" };
    }

    if (entryKeyXdrs.length === 0) {
        return { success: false, contractId, entriesRestored: 0, error: "No entries to restore" };
    }

    const client = new StellarRpcClient(contract.network, rpcUrl);

    logger.info(`Restoring ${entryKeyXdrs.length} entries for ${contractId}`);

    let txResult;
    try {
        txResult = await client.submitRestore(entryKeyXdrs, secretKey);
    } catch (err: any) {
        logger.warn(`Simulation warning for ${contractId}: ${err.message}`);
        return {
            success: false,
            contractId,
            entriesRestored: 0,
            error: err.message,
        };
    }

    if (!txResult.success) {
        logger.error(`Restore failed for ${contractId}: ${txResult.error}`);
        return {
            success: false,
            contractId,
            entriesRestored: 0,
            txHash: txResult.txHash || undefined,
            error: txResult.error,
        };
    }

    const freshTTLs = await client.getEntryTTLs(entryKeyXdrs);
    const entries = getEntriesForContract(db, contractId);
    const entryMap = new Map(entries.map(e => [e.entry_key_xdr, e]));

    let restored = 0;

    const updateDb = db.transaction(() => {
        for (const freshEntry of freshTTLs.entries) {
            const dbEntry = entryMap.get(freshEntry.entryKeyXdr);
            if (!dbEntry) continue;

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: freshEntry.entryKeyXdr,
                entry_type: dbEntry.entry_type,
                label: dbEntry.label ?? undefined,
                live_until_ledger: freshEntry.liveUntilLedgerSeq,
                last_modified_ledger: freshEntry.lastModifiedLedgerSeq,
                discovery_source: dbEntry.discovery_source,
            });
            restored++;
        }

        updateLastCheckedLedger(db, contractId, freshTTLs.latestLedger);
    });
    updateDb();

    logger.info(`Restore successful for ${contractId}: tx=${txResult.txHash}, entries=${restored}`);

    return {
        success: true,
        contractId,
        entriesRestored: restored,
        txHash: txResult.txHash,
        ledger: txResult.ledger,
        cpuInsns: txResult.cpuInsns,
        memBytes: txResult.memBytes,
        minResourceFee: txResult.minResourceFee,
        feeCharged: txResult.feeCharged,
    };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a secret key from a keypair_source string.
 * Supports:
 *   - "env:VAR_NAME" — reads from environment variable
 *   - "vault:<secret_path>" — reads from HashiCorp Vault (KV v1/v2)
 *   - Direct secret key string starting with "S" (56 chars)
 */
export async function resolveSecretKey(source: string | null): Promise<string | null> {
    if (!source) return null;

    if (source.startsWith("env:")) {
        const envVar = source.slice(4);
        const value = process.env[envVar];
        if (!value) {
            logger.warn(`Environment variable ${envVar} not set`);
            return null;
        }
        return value;
    }

    if (source.startsWith("vault:")) {
        const vaultPath = source.slice(6);
        if (!vaultPath) {
            logger.warn("Vault keypair_source is empty");
            return null;
        }

        try {
            const config = loadConfig();
            if (!config.vault?.url || !config.vault?.token) {
                logger.error("Vault resolver requested but vault configuration missing in config.yaml (vault.url / vault.token)");
                return null;
            }

            const resolver = new VaultResolver({
                url: config.vault.url,
                token: config.vault.token,
                namespace: config.vault.namespace,
            });

            const secret = await resolver.getSecret(vaultPath);
            return secret;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to resolve secret from Vault path "${vaultPath}": ${message}`);
            return null;
        }
    }

    // Direct secret key
    if (source.startsWith("S") && source.length === 56) {
        return source;
    }

    logger.warn(`Unknown keypair_source format: ${formatSecretKey(source)}`);
    return null;
}
