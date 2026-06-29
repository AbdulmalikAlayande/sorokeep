# Implementation Plan: Adaptive Polling Intervals

## Overview

Replace the static `setInterval` daemon loop with a `setTimeout`-chained adaptive scheduler that
tightens polling frequency as contract TTLs approach expiry. The change introduces a new pure
module (`src/daemon/interval.ts`) for all interval arithmetic, extends `MonitorCycleResult` with
`remainingTTLs`, and wires the computation into `loop.ts` while preserving full backward
compatibility with the existing `intervalMs` option.

## Tasks

- [ ] 1. Install fast-check dev dependency
  - Add `fast-check@^3.22.0` (or latest 3.x) as a dev dependency via `npm install --save-dev fast-check@^3.22.0`
  - Confirm the version resolves and that `package.json` devDependencies is updated
  - _Requirements: (testing infrastructure — supports Requirements 4.1–4.5)_

- [ ] 2. Create `src/daemon/interval.ts` — pure interval computation module
  - [ ] 2.1 Define exported constants and `IntervalPolicy` interface
    - Export tier boundary constants: `TTL_TIER_CRITICAL = 720`, `TTL_TIER_DAY = 17_280`, `TTL_TIER_WEEK = 120_960`
    - Export default interval constants: `DEFAULT_MIN_INTERVAL_MS`, `DEFAULT_MAX_INTERVAL_MS`, `DEFAULT_INTERVAL_CRITICAL_MS`, `DEFAULT_INTERVAL_DAY_MS`, `DEFAULT_INTERVAL_WEEK_MS`, `DEFAULT_INTERVAL_SAFE_MS`
    - Define and export `IntervalPolicy` interface with all optional fields (`minIntervalMs`, `maxIntervalMs`, `criticalIntervalMs`, `dayIntervalMs`, `weekIntervalMs`, `safeIntervalMs`, `criticalTtlLedgers`, `dayTtlLedgers`, `weekTtlLedgers`)
    - No imports from `logging/` or any I/O module — pure module only
    - _Requirements: 1.1, 3.2, 3.3, 4.1_

  - [ ] 2.2 Implement `ttlToIntervalMs(remainingTTL: number, policy?: IntervalPolicy): number`
    - Merge supplied policy over defaults to resolve all tier parameters
    - Apply four-tier classification: `< criticalTtlLedgers` → `criticalIntervalMs`; `< dayTtlLedgers` → `dayIntervalMs`; `< weekTtlLedgers` → `weekIntervalMs`; else → `safeIntervalMs`
    - Return the raw (unclamped) tier interval
    - Negative and zero TTL values fall into the critical tier (< 720 threshold) naturally
    - _Requirements: 1.1, 3.2_

  - [ ] 2.3 Implement `computeEffectiveInterval(remainingTTLs: number[], policy?: IntervalPolicy): number`
    - Return `maxIntervalMs` when `remainingTTLs` is empty
    - Map each TTL through `ttlToIntervalMs`, take the minimum
    - Clamp result to `[minIntervalMs, maxIntervalMs]`
    - Function must be pure and deterministic (no side-effects)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 2.4 Implement `validateIntervalPolicy(policy: IntervalPolicy | undefined): void`
    - No-op for `undefined` or `null`
    - Throw descriptive `Error` if any tier interval < 10,000 ms: `IntervalPolicy: {field} must be ≥ 10,000 ms (got {value})`
    - Throw descriptive `Error` if `minIntervalMs` > any tier interval: `IntervalPolicy: minIntervalMs ({value}) exceeds tier interval {field} ({tierValue})`
    - _Requirements: 3.4, 3.5_

- [ ] 3. Extend `MonitorCycleResult` in `src/core/monitor.ts`
  - Add `remainingTTLs: number[]` field to the `MonitorCycleResult` interface (non-breaking — initialise to `[]` in `runMonitorCycle`)
  - Populate `remainingTTLs` inside `processContract` by appending `rpcEntry.remainingTTL` to the result array for each successfully updated entry (where `rpcEntry` is defined)
  - _Requirements: 4.1, 2.1_

- [ ] 4. Refactor `src/daemon/loop.ts` — Scheduler wiring
  - [ ] 4.1 Update `DaemonOptions` interface and module-level state
    - Add `intervalPolicy?: IntervalPolicy` field to `DaemonOptions`
    - Replace `intervalHandle: ReturnType<typeof setInterval>` with `timeoutHandle: ReturnType<typeof setTimeout> | null`
    - Add module-level `currentEffectiveMs: number` (initialised to `DEFAULT_MAX_INTERVAL_MS`) and `activePolicy: IntervalPolicy | undefined`
    - Import `computeEffectiveInterval`, `validateIntervalPolicy`, `IntervalPolicy`, and `DEFAULT_MAX_INTERVAL_MS` from `./interval.js`
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 4.2 Implement backward-compatible policy resolution in `startDaemon`
    - Call `validateIntervalPolicy(options?.intervalPolicy)` before any async work; let it throw on invalid config
    - When `intervalMs` is present, synthesise `activePolicy = { minIntervalMs: intervalMs, maxIntervalMs: intervalMs }` to disable adaptive behaviour
    - When only `intervalPolicy` is present, assign `activePolicy = options.intervalPolicy`
    - When neither is present, leave `activePolicy = undefined` (built-in defaults apply)
    - Initialise `currentEffectiveMs` to resolved `maxIntervalMs` (or `DEFAULT_MAX_INTERVAL_MS`)
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 4.3 Replace `setInterval` with chained `setTimeout` scheduling
    - Replace `clearInterval` / `setInterval` calls with `clearTimeout` / `setTimeout`
    - After the initial cycle in `startDaemon`, call a new `scheduleNext` helper to compute the interval and set the next timeout
    - In `scheduledTick`, after a completed cycle, call `scheduleNext` again (chained pattern)
    - `stopDaemon` must call `clearTimeout(timeoutHandle)` and set `timeoutHandle = null`
    - _Requirements: 2.3, 2.4, 2.5_

  - [ ] 4.4 Implement `scheduleNext` helper and interval computation
    - On successful cycle (zero errors and no thrown exception): call `computeEffectiveInterval(result.remainingTTLs, activePolicy)` and store in `currentEffectiveMs`
    - On error cycle (non-empty `errors` or thrown exception): retain existing `currentEffectiveMs` unchanged
    - Clear the existing timeout, then call `setTimeout(tick, currentEffectiveMs)` where `tick` is the `scheduledTick` closure
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 4.5 Add re-entrance guard and structured logging
    - Re-entrance guard in `scheduledTick`: if `cycleInFlight` is true, log at `debug` level (`"Skipping tick — previous cycle still in flight"`) and return without scheduling a new cycle; reschedule normally when the in-flight cycle finishes
    - Emit `info` log after every rescheduling: `Scheduler — next cycle in {effectiveMs}ms | minTTL={minRemainingTTL} ledgers | errors={errorCount}`
    - When interval changes vs previous cycle, append: | `intervalChanged: {previousMs}ms → {effectiveMs}ms`
    - When `remainingTTLs` is empty, emit `debug` log: `Scheduler — no TTL data available; using maxInterval={maxIntervalMs}ms`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3_

- [ ] 5. Checkpoint — verify build and existing tests pass
  - Run `npm run build` and confirm zero TypeScript errors
  - Run `npm test` and confirm all pre-existing tests in `tests/daemon/loop.test.ts` and other suites continue to pass
  - Fix any timer-advance tests in `loop.test.ts` that relied on `setInterval` to use `vi.advanceTimersByTimeAsync` with chained `setTimeout` correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Write unit tests — `tests/daemon/interval.test.ts`
  - [ ] 6.1 Test `ttlToIntervalMs` tier classification with concrete boundary values
    - TTL = 0 → critical interval (60,000 ms)
    - TTL = -1 → critical interval (negative falls into critical tier)
    - TTL = 719 → critical interval (one below `TTL_TIER_CRITICAL`)
    - TTL = 720 → day interval (exactly at `TTL_TIER_CRITICAL`)
    - TTL = 17,279 → day interval (one below `TTL_TIER_DAY`)
    - TTL = 17,280 → week interval (exactly at `TTL_TIER_DAY`)
    - TTL = 120,959 → week interval (one below `TTL_TIER_WEEK`)
    - TTL = 120,960 → safe interval (exactly at `TTL_TIER_WEEK`)
    - _Requirements: 1.1_

  - [ ] 6.2 Test `computeEffectiveInterval` with concrete examples
    - Empty array → `DEFAULT_MAX_INTERVAL_MS` (3,600,000 ms)
    - Single critical TTL → 60,000 ms
    - Mixed-tier array → minimum of the per-entry tier values
    - `intervalMs` scalar override → always returns the override value
    - Custom `IntervalPolicy` tiers are applied correctly
    - _Requirements: 1.2, 1.3, 3.1, 3.2, 4.2_

  - [ ] 6.3 Test `validateIntervalPolicy` error paths
    - Policy with `criticalIntervalMs: 9999` → throws with message containing `criticalIntervalMs` and `10,000`
    - Policy with `dayIntervalMs: 9999` → throws
    - Policy with `minIntervalMs: 70_000` and `criticalIntervalMs: 60_000` → throws (minInterval > tier)
    - Valid policy → does not throw
    - `undefined` → does not throw
    - _Requirements: 3.4, 3.5_

- [ ] 7. Write property-based tests — `tests/daemon/interval.property.test.ts`
  - [ ] 7.1 Property 1: Tier mapping correctness
    - Tag: `// Feature: adaptive-polling-intervals, Property 1: Tier mapping correctness`
    - Generate TTL values in each of the four tier ranges using `fc.integer` with appropriate bounds
    - Assert each individual TTL is classified into the expected tier interval
    - For mixed-tier arrays, assert result equals `clamp(min(per-entry tiers), min, max)`
    - Configure `{ numRuns: 100 }` minimum
    - _Requirements: 1.1, 1.2, 3.2_

  - [ ] 7.2 Property 2: Range invariant
    - Tag: `// Feature: adaptive-polling-intervals, Property 2: Range invariant`
    - Generate arbitrary TTL arrays including empty, negative values: `fc.array(fc.integer({ min: -1000, max: 500_000 }))`
    - Assert `result >= DEFAULT_MIN_INTERVAL_MS && result <= DEFAULT_MAX_INTERVAL_MS` for all inputs
    - Configure `{ numRuns: 100 }` minimum
    - _Requirements: 1.3, 1.4, 1.5, 4.2, 4.3_

  - [ ] 7.3 Property 3: Purity and determinism
    - Tag: `// Feature: adaptive-polling-intervals, Property 3: Purity and determinism`
    - Generate `fc.array(fc.nat())`; call `computeEffectiveInterval(ttls)` twice; assert strict equality (`===`)
    - Configure `{ numRuns: 100 }` minimum
    - _Requirements: 4.4_

  - [ ] 7.4 Property 4: Uniform-array invariant
    - Tag: `// Feature: adaptive-polling-intervals, Property 4: Uniform-array invariant`
    - Generate `fc.nat()` for value and `fc.integer({ min: 1, max: 50 })` for length
    - Assert `computeEffectiveInterval(Array(n).fill(v))` returns the same value for all `n ≥ 1`
    - Configure `{ numRuns: 100 }` minimum
    - _Requirements: 4.5_

- [ ] 8. Write integration tests — `tests/daemon/loop.adaptive.test.ts`
  - [ ] 8.1 Successful cycle uses computed interval for next `setTimeout`
    - Mock `runMonitorCycle` to return a result with specific `remainingTTLs`
    - Assert the delay passed to the next `setTimeout` equals `computeEffectiveInterval(remainingTTLs)`
    - _Requirements: 2.1_

  - [ ] 8.2 Error cycle retains previous effective interval
    - Mock `runMonitorCycle` first call succeeds (sets `currentEffectiveMs`), second call returns non-empty `errors`
    - Assert next `setTimeout` delay equals the interval from the first successful cycle
    - _Requirements: 2.2_

  - [ ] 8.3 `intervalMs` override disables adaptive behaviour
    - Start daemon with `{ intervalMs: 15_000 }`; mock cycle with low TTL data
    - Assert every `setTimeout` delay is exactly 15,000 ms
    - _Requirements: 3.1_

  - [ ] 8.4 Custom `intervalPolicy` tiers are applied
    - Supply a custom policy with a distinct `safeIntervalMs`; mock cycle with high TTL values
    - Assert the resulting delay matches the custom policy's `safeIntervalMs`
    - _Requirements: 3.2_

  - [ ] 8.5 Interval-change log entry emitted
    - Spy on logger; drive two consecutive cycles where the computed interval changes
    - Assert the `info` log contains both previous and new interval values
    - _Requirements: 5.2_

  - [ ] 8.6 Empty watch list logs at debug level
    - Mock `runMonitorCycle` to return `{ remainingTTLs: [] }` (empty watch list)
    - Assert a `debug` log entry containing `maxInterval` is emitted
    - _Requirements: 5.3_

- [ ] 9. Final checkpoint — Ensure all tests pass
  - Run `npm test` and confirm all unit, property, and integration tests pass
  - Run `npm run build` for a clean TypeScript compile
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Each task references specific requirements for traceability
- The `setInterval` → `setTimeout` chain change requires updating any existing timer tests in `loop.test.ts` that call `vi.advanceTimersByTimeAsync` — Vitest handles chained `setTimeout` identically
- `fast-check` must be installed (task 1) before property tests can be written (task 7)
- `MonitorCycleResult.remainingTTLs` (task 3) must be added before the integration tests in task 8 can work end-to-end
- All existing tests must continue to pass without modification; backward compatibility is enforced by the `intervalMs` degenerate-policy path

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["3", "6.1", "7.1", "7.2", "7.3", "7.4"] },
    { "id": 3, "tasks": ["4.1", "6.2", "6.3"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "4.5"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] }
  ]
}
```
