# ADR-003: Use Commander.js for CLI Framework

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Sorokeep exposes a CLI with multiple commands (`watch`, `status`, `daemon`, `alerts`, `guard`, `costs`, `restore`), each with subcommands and options. A CLI framework is needed to handle argument parsing, help text generation, and command routing.

## Decision Drivers

- **Fast startup** — CLI commands (especially `status`) should feel instantaneous. Framework overhead at startup is directly visible to the user.
- **Small dependency footprint** — Minimize `node_modules` size and install time.
- **Subcommand support** — Deeply nested commands (`alerts add`, `alerts list`, `alerts remove`, etc.) with shared options.
- **TypeScript compatibility** — The framework should not fight TypeScript's type system.
- **Active maintenance** — Regular releases, security patches, and community adoption.

## Considered Options

| Option | Size (unpacked) | Dependencies | Startup Time | Subcommands |
|--------|-----------------|--------------|--------------|-------------|
| Commander.js | ~300KB | 0 | ~5ms | Native |
| oclif | ~12MB | 30+ | ~85-135ms | Native |
| yargs | ~800KB | 8 | ~15ms | Via middleware |
| Bare `process.argv` | 0 | 0 | 0ms | Manual |

## Decision Outcome

**Chosen option: Commander.js v14**

Rationale:

1. **Startup performance** — Commander.js adds ~5ms to startup. oclif adds 85-135ms due to plugin loading and lifecycle hooks. For a CLI tool users invoke repeatedly for quick status checks, every millisecond matters.
2. **Zero dependencies** — Commander.js has no runtime dependencies. This means fewer `npm audit` findings and smaller installs.
3. **Clean API** — `.command()`, `.option()`, `.argument()` chain naturally. Subcommands are created by nesting `Command` instances, which maps cleanly to Sorokeep's command tree.
4. **TypeScript support** — Commander v14 includes full TypeScript declarations. Program options can be typed with generics.

### Consequences

- **Positive:** Each command handler is a separate module in `src/commands/`. Registration is a single `register*Command(program)` call from `src/index.ts`.
- **Positive:** Commander generates `--help` output automatically from registered options and descriptions.
- **Neutral:** Subcommand modules invoke core business logic (in `src/core/`) but never contain business logic themselves. This keeps the CLI layer thin and testable.
- **Negative:** Commander does not support nested subcommands in the same fluent style as oclif's topics. Sorokeep works around this by registering `alerts` as a command with its own subcommand parser, which is sufficient for the current depth.

## Validation

- All commands produce correct help output verified by manual testing.
- Error handling (missing required options, invalid arguments) produces clear messages via Commander's built-in validation.
- Command handlers format core function return values for terminal display, confirmed by `tests/commands/alerts.test.ts`.
