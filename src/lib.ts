/**
 * Sorokeep public library API.
 *
 * Re-exports the core programmatic functions so Node.js consumers can
 * import them without pulling in any CLI (Commander.js) dependencies.
 *
 * @example
 * ```ts
 * import { watchContract, runMonitorCycle } from "sorokeep";
 * ```
 */
export { watchContract } from "./core/watch.js";
export type { WatchOptions, WatchResult } from "./core/watch.js";

export { runMonitorCycle } from "./core/monitor.js";
export type { MonitorCycleResult } from "./core/monitor.js";
