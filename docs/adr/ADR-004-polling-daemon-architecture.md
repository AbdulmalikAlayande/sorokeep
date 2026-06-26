# ADR-004: Polling Daemon Architecture

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Sorokeep must continuously monitor Soroban contract TTLs and react when they cross configured thresholds. The core architectural question is whether to poll for changes on a schedule or receive push notifications when state changes.

The Soroban RPC does not support WebSocket subscriptions for ledger entry changes. All data access is via HTTP request-response methods (`getLedgerEntries`, `getLatestLedger`).

## Decision Drivers

- **RPC capability** — The Stellar RPC API determines what's technically possible
- **Timeliness** — TTLs span tens of thousands of ledgers (~7-30 days). Sub-second notification is unnecessary
- **RPC load** — Excessive polling could rate-limit or burden the RPC endpoint
- **Simplicity** — The monitoring logic should be easy to reason about and test
- **Reliability** — No alerts should be missed due to connectivity gaps

## Considered Options

| Option | Mechanism | Real-time | RPC Load | Complexity |
|--------|-----------|-----------|----------|------------|
| Polling | Interval-based `getLedgerEntries` calls | Minute-level | Configurable | Low |
| WebSocket | Push notifications from RPC | Sub-second | Minimal | N/A (not available) |
| Event polling | Poll `getEvents` for relevant operations | Block-level | Higher | Medium |

## Decision Outcome

**Chosen option: Interval-based polling**

Rationale:

1. **RPC reality** — The Soroban RPC does not support WebSocket subscriptions for ledger entries. Polling is the only viable approach.
2. **TTL granularity** — TTLs are measured in thousands of ledgers (~5 seconds per ledger on Stellar). A 5-minute polling interval provides more than adequate precision — no meaningful TTL change can be missed between polls.
3. **Configurable interval** — Users can set `--interval` (minimum 10 seconds) for more aggressive monitoring, or accept the default 5-minute interval for minimal RPC load.
4. **Isolation** — Each cycle runs independently with a re-entrance guard. If one cycle takes longer than the interval, the next cycle waits. This prevents overlapping requests and RPC flooding.
5. **Graceful degradation** — Failed cycles (network blips, RPC timeouts) do not abort subsequent cycles. Error isolation keeps each phase (monitor, deliver, auto-extend) independent.

### Consequences

- **Positive:** The daemon cycle maps directly to a `while (running) { await sleep(interval); runCycle(); }` loop in `src/daemon/loop.ts`. The entire state machine is deterministic and testable.
- **Positive:** `runMonitorCycle` in `src/core/monitor.ts` is a pure function over (database, RPC client) — no timers, no side effects. This makes the 800+ lines of monitor tests possible with mocked RPC responses.
- **Positive:** Alert deduplication is simple — if an unresolved alert already exists for an entry/threshold pair, no duplicate is fired. This naturally prevents alert storms.
- **Negative:** Polling adds latency between a TTL change and detection (up to the polling interval). This is acceptable given TTL magnitudes.
- **Negative:** Polling generates RPC requests even when nothing changed. The `getLatestLedger` method is lightweight and used first to skip full TTL fetches if the ledger hasn't advanced significantly.

## Validation

- Daemon cycle orchestration is tested in `tests/daemon/loop.test.ts` (start/stop, re-entrance guard, cycle isolation).
- Monitor cycle logic is tested in `tests/core/monitor.test.ts` (threshold detection, resolution, fault isolation, multi-threshold escalation).
- All tests use mocked RPC responses — no network calls.
