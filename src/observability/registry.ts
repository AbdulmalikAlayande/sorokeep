import type Database from "better-sqlite3";
import { Registry } from "prom-client";

export const register = new Registry();

import { budgetRemainingGauge, collectBudgetRemaining } from "./metrics/budget.js";
register.registerMetric(budgetRemainingGauge);

import { entryTtlRemainingGauge, setEntryTtlGaugeSamples } from "./metrics/ttl.js";
register.registerMetric(entryTtlRemainingGauge);

import { extensionCostXlmTotal, extensionsTotal, collectExtensionCostMetrics } from "./metrics/cost.js";
register.registerMetric(extensionCostXlmTotal);
register.registerMetric(extensionsTotal);

import { daemonCycleDuration, daemonCyclesSkipped } from "./metrics/daemon.js";
register.registerMetric(daemonCycleDuration);
register.registerMetric(daemonCyclesSkipped);

import { contractsTrackedGauge, entriesTrackedGauge, collectFleetMetrics } from "./metrics/fleet.js";
register.registerMetric(contractsTrackedGauge);
register.registerMetric(entriesTrackedGauge);

import { mcpToolInvocationsCounter } from "./metrics/mcp.js";
register.registerMetric(mcpToolInvocationsCounter);

import { alertsDeliveredTotal, alertsFailedTotal, alertsAbandonedTotal, alertDeliveryDurationSeconds } from "./metrics/alerts.js";
register.registerMetric(alertsDeliveredTotal);
register.registerMetric(alertsFailedTotal);
register.registerMetric(alertsAbandonedTotal);
register.registerMetric(alertDeliveryDurationSeconds);

/**
 * Recompute every DB-backed metric from the live database. Called once per
 * `/metrics` scrape (see `observability/server.ts`) so gauges never emit
 * stale or empty data — there's no caching layer, each metric file just
 * queries the current DB state.
 */
export function collectAllMetrics(db: Database.Database): void {
    collectBudgetRemaining(db);
    setEntryTtlGaugeSamples(db);
    collectExtensionCostMetrics(db);
    collectFleetMetrics(db);
}
