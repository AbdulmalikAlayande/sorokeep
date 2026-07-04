# Requirements Document

## Introduction

The Sorokeep daemon currently polls all watched Soroban contract entries at a fixed interval (default 5 minutes, user-configurable). This is wasteful when all TTLs are comfortably far from expiry, and potentially too slow to catch critical expirations in their final hour. This feature replaces the static interval with an **adaptive polling schedule** that tightens as TTLs approach expiry and relaxes when they are safely distant.

After every monitor cycle, the Scheduler computes the shortest interval dictated by the lowest remaining TTL across all watched entries and reschedules the next cycle accordingly. No interval may fall below 60 seconds or exceed 3,600,000 ms (1 hour) by default.

All TTL values in the system are measured in **ledgers**. Stellar closes one ledger approximately every 5 seconds. The polling interval tiers defined in this document use ledger counts derived from those wall-clock approximations:

| Wall-clock duration | Approximate ledgers |
|---------------------|---------------------|
| 1 hour              | 720 ledgers         |
| 24 hours            | 17,280 ledgers      |
| 7 days              | 120,960 ledgers     |

---

## Glossary

- **Scheduler**: The component inside `src/daemon/loop.ts` responsible for timing daemon cycles and rescheduling the next cycle after each run.
- **Cycle**: One complete execution of `runMonitorCycle` together with its follow-on steps (alert delivery, introspection rescan, auto-extension, cost snapshot).
- **Remaining TTL**: The number of ledgers a contract entry has left before expiry, computed as `liveUntilLedgerSeq − latestLedger` at the time of the RPC call. Stored as `remainingTTL` on `SorokeepLedgerEntryResult`.
- **Effective Interval**: The wall-clock polling interval in milliseconds that the Scheduler selects for the next cycle, derived from the minimum remaining TTL across all entries seen in the just-completed cycle.
- **Interval Tier**: A mapping rule that translates a remaining TTL range into a specific polling interval.
- **Minimum Interval**: The floor below which the Scheduler will never schedule a cycle, regardless of TTL. Default: 60,000 ms (1 minute).
- **Maximum Interval**: The ceiling above which the Scheduler will never schedule a cycle, regardless of TTL. Default: 3,600,000 ms (1 hour).
- **TTL Tier Boundary**: A ledger count threshold that separates two Interval Tiers.
- **DaemonOptions**: The configuration object passed to `startDaemon` in `src/daemon/loop.ts`.
- **IntervalPolicy**: A configuration object (part of `DaemonOptions`) that holds the tier boundaries and their associated intervals.

---

## Requirements

### Requirement 1: Interval Tier Calculation

**User Story:** As a contract operator, I want the daemon to check more frequently as a contract entry approaches expiry, so that I receive timely alerts and have enough time to act before an entry expires.

#### Acceptance Criteria

1. WHEN the Scheduler computes the Effective Interval after a cycle, THE Scheduler SHALL classify each entry's remaining TTL into exactly one of the following tiers and map it to the listed interval:
   - Remaining TTL ≥ 120,960 ledgers (> 7 days): 3,600,000 ms (1 hour)
   - Remaining TTL < 120,960 ledgers and ≥ 17,280 ledgers (≤ 7 days and > 24 hours): 300,000 ms (5 minutes)
   - Remaining TTL < 17,280 ledgers and ≥ 720 ledgers (≤ 24 hours and > 1 hour): 300,000 ms (5 minutes)
   - Remaining TTL < 720 ledgers (≤ 1 hour): 60,000 ms (1 minute)
2. WHEN the Scheduler computes the Effective Interval, THE Scheduler SHALL select the minimum interval produced across all entries from all watched contracts on the active network.
3. WHEN no watched contracts exist for the active network or all contracts have zero tracked entries, THE Scheduler SHALL use the Maximum Interval as the Effective Interval.
4. THE Scheduler SHALL ensure the Effective Interval is never less than the Minimum Interval (default 60,000 ms).
5. THE Scheduler SHALL ensure the Effective Interval is never greater than the Maximum Interval (default 3,600,000 ms).

### Requirement 2: Dynamic Rescheduling

**User Story:** As a contract operator, I want the daemon to reschedule itself based on the most recent TTL data after every cycle, so that the polling frequency always reflects the current urgency of the watched entries.

#### Acceptance Criteria

1. WHEN a cycle completes without any errors (zero entries in `MonitorCycleResult.errors` and no thrown exception), THE Scheduler SHALL compute the Effective Interval using the remaining TTL values returned by the most recent `runMonitorCycle` call.
2. WHEN a cycle produces one or more errors (non-empty `MonitorCycleResult.errors` or a thrown exception), THE Scheduler SHALL reschedule the next cycle using the previous Effective Interval without altering the interval.
3. THE Scheduler SHALL cancel the existing timer before scheduling a new one, so that at most one pending cycle exists at any point in time.
4. WHEN `startDaemon` is called, THE Scheduler SHALL run the first cycle immediately without waiting for the initial Effective Interval to elapse.
5. WHEN `stopDaemon` is called, THE Scheduler SHALL cancel the pending timer and prevent any further cycles from being scheduled.

### Requirement 3: Backward-Compatible Configuration

**User Story:** As a developer integrating with the daemon, I want to retain the existing `intervalMs` override while also being able to configure tier boundaries, so that existing deployments are unaffected and new deployments can customise the adaptive behaviour.

#### Acceptance Criteria

1. WHERE the caller supplies `intervalMs` in `DaemonOptions`, THE Scheduler SHALL use that fixed value as both the Minimum Interval and the Maximum Interval, effectively disabling adaptive behaviour.
2. WHERE the caller supplies an `IntervalPolicy` in `DaemonOptions`, THE Scheduler SHALL use the tier boundaries and interval values from that policy in place of the built-in defaults.
3. WHERE neither `intervalMs` nor `IntervalPolicy` is supplied, THE Scheduler SHALL apply the default tier boundaries and intervals defined in Requirement 1.
4. IF `IntervalPolicy` specifies a tier interval below 10,000 ms, THEN THE Scheduler SHALL reject the configuration and throw an `Error` describing the violation before the daemon starts. WHERE all tier intervals meet the 10,000 ms floor and all other validation rules pass, THE Scheduler SHALL allow the daemon to start without throwing.
5. IF `IntervalPolicy` specifies a Minimum Interval greater than any tier interval, THEN THE Scheduler SHALL reject the configuration and throw an `Error` describing the violation before the daemon starts.

### Requirement 4: Interval Derivation from Cycle Results

**User Story:** As a developer, I want the interval calculation to be a pure, testable function that takes TTL data and an optional policy and returns a millisecond interval, so that I can write isolated unit tests without starting the daemon.

#### Acceptance Criteria

1. THE Scheduler SHALL expose a pure function `computeEffectiveInterval(remainingTTLs: number[], policy?: IntervalPolicy): number` that accepts an array of remaining TTL values (in ledgers) and an optional policy, and returns the Effective Interval in milliseconds.
2. WHEN `remainingTTLs` is an empty array, THE `computeEffectiveInterval` function SHALL return the Maximum Interval from the supplied policy, or the default Maximum Interval if no policy is supplied.
3. FOR ALL arrays of remaining TTL values, the result of `computeEffectiveInterval` SHALL fall within the range `[MinimumInterval, MaximumInterval]` inclusive.
4. FOR ALL arrays of remaining TTL values `ttls`, `computeEffectiveInterval(ttls)` SHALL equal `computeEffectiveInterval(ttls)` when called a second time with the same input — the function is pure and deterministic.
5. WHEN all values in `remainingTTLs` are equal, THE `computeEffectiveInterval` function SHALL return the same result regardless of array length.

### Requirement 5: Observability

**User Story:** As an operator, I want the daemon to log the computed Effective Interval before each scheduled cycle, so that I can confirm the adaptive logic is working correctly without inspecting source code.

#### Acceptance Criteria

1. WHEN the Scheduler reschedules a cycle, THE Scheduler SHALL emit a log entry at the `info` level containing the Effective Interval in milliseconds and the minimum remaining TTL (in ledgers) that produced it.
2. WHEN the Effective Interval changes relative to the previous cycle, THE Scheduler SHALL log the previous and new interval values in the same log entry.
3. WHEN no TTL data is available (empty watch list), THE Scheduler SHALL emit a log entry at the `debug` level indicating that the Maximum Interval is being used.
4. IF a cycle completes with one or more contract errors, THEN THE Scheduler SHALL log the count of failed contracts (which may be zero) alongside the Effective Interval so that operators can correlate polling rate changes with monitoring failures.

### Requirement 6: Re-entrance Safety

**User Story:** As an operator running the daemon in a resource-constrained environment, I want the daemon to never start a new cycle while the previous one is still running, so that RPC requests do not pile up if a cycle takes longer than the Effective Interval.

#### Acceptance Criteria

1. WHILE a cycle is in flight, THE Scheduler SHALL skip any timer tick that fires before the in-flight cycle finishes, and THE Scheduler SHALL emit a log entry at the `debug` level indicating the skip reason.
2. WHEN a timer tick fires during an in-flight cycle, THE Scheduler SHALL always skip it — a second concurrent cycle SHALL never be started.
3. WHEN the in-flight cycle finishes after a skip, THE Scheduler SHALL reschedule the next cycle normally using the freshly computed Effective Interval.
