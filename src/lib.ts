/**
 * Sorokeep public library API.
 *
 * Re-exports the core programmatic functions so Node.js consumers can
 * import them without pulling in any CLI (Commander.js) dependencies.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * import { watchContract, runMonitorCycle } from "sorokeep";
 * ```
 */

// ─── Contract watching ────────────────────────────────────────────────────────

export { watchContract } from "./core/watch.js";
export type { WatchOptions, WatchResult } from "./core/watch.js";

// ─── Monitor cycle ────────────────────────────────────────────────────────────

export { runMonitorCycle } from "./core/monitor.js";
export type { MonitorCycleResult } from "./core/monitor.js";

// ─── Contract inspection ──────────────────────────────────────────────────────

export { inspectContract, parseSacBalance, buildSacBalanceKeyXdr, formatTokenBalance } from "./core/inspect.js";
export type { InspectOptions, InspectResult, InspectEntryInfo } from "./core/inspect.js";

// ─── AWS Secrets Manager integration ──────────────────────────────────────────

export { AWSSecretsResolver } from "./core/aws_secrets.js";
export type { AWSSecretsResolverConfig } from "./core/aws_secrets.js";

export { registerAlertChannel } from "./alerts/registry.js";
export type { ChannelDefinition } from "./alerts/registry.js";

// ─── Webhook verification ────────────────────────────────────────────────────

export { verifyWebhookSignature } from "./alerts/webhook.js";

