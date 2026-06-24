# ADR-005: Use TypeScript (Not Rust)

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Soroban smart contracts are written in Rust. It would be natural to consider Rust for the monitoring tool as well, given the domain alignment. However, Sorokeep is an off-chain operational tool, not a smart contract. The decision affects developer experience, distribution, and the contributor community.

## Decision Drivers

- **Developer ecosystem** — Soroban developers commonly use TypeScript/JavaScript for dApp frontends and scripts
- **SDK maturity** — The Stellar JS SDK (`@stellar/stellar-sdk`) is the most complete client library for Soroban RPC
- **Distribution simplicity** — npm publish vs. cross-compiled binaries for multiple platforms
- **Performance requirements** — Periodic RPC polling does not require Rust's performance characteristics
- **Contributor pool** — A TypeScript codebase has a larger potential contributor base than Rust

## Considered Options

| Option | SDK Quality | Distribution | Performance | Contributor Pool |
|--------|-------------|--------------|-------------|-----------------|
| TypeScript | Excellent (official Stellar SDK) | npm (zero-friction) | Sufficient | Large (JS/TS devs) |
| Rust | Limited (no official Soroban RPC client crate) | Cross-compile binaries | Excellent | Small (Rust/Soroban devs) |
| Go | Limited (community SDK) | Single binary | Good | Medium |

## Decision Outcome

**Chosen option: TypeScript**

Rationale:

1. **Stellar SDK maturity** — `@stellar/stellar-sdk` provides first-class support for Soroban RPC interactions: `getLedgerEntries`, `simulateTransaction`, `prepareTransaction`, `sendTransaction`, and `getTransaction`. No Rust crate offers comparable coverage for off-chain RPC operations.
2. **Developer experience** — Soroban developers already have Node.js in their toolchains. Installing via `npm install -g sorokeep` is zero-friction. There is no compilation step for the end user.
3. **Performance is not a constraint** — Sorokeep makes one RPC call every 5 minutes per network. CPU usage is negligible. The performance characteristics of Rust would provide no practical benefit.
4. **npm distribution** — Publishing to npm is simpler than maintaining CI pipelines for macOS, Linux, and Windows binary builds.
5. **Larger contributor base** — TypeScript is the most popular language for Stellar ecosystem tooling. Most PRs to Soroban-related projects are in TypeScript.

### Consequences

- **Positive:** The `tsx` runner enables instant iteration during development without compile steps.
- **Positive:** TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess`) catches null/undefined errors at compile time, compensating for the lack of Rust's ownership guarantees.
- **Neutral:** The `src/core/` directory contains pure business logic that could be extracted to Rust in the future if performance requirements change, but this is not anticipated.
- **Negative:** Native addons (`better-sqlite3`) must be compiled per platform. This is handled by `npm install` and is transparent on supported platforms.
- **Negative:** Startup time (Node.js process launch) is ~50-100ms vs near-instant for a compiled Rust binary. This is acceptable for a monitoring tool that runs as a daemon.

## Validation

- TypeScript compilation is verified in CI with `npx tsc --noEmit`.
- All 238+ tests pass with `npx vitest run`.
- The CLI starts and responds to `--help` within ~100ms on modern hardware.
