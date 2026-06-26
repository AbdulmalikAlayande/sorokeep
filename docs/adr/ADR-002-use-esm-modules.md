# ADR-002: Use ESM (ECMAScript Modules)

**Status:** Accepted
**Date:** 2026-06-24
**Deciders:** @AbdulmalikAlayande

## Context

Sorokeep is a Node.js CLI application. Node.js supports two module systems: CommonJS (`require`, `module.exports`) and ES Modules (`import`, `export`). The project must choose one as the primary module format.

## Decision Drivers

- **Modern JavaScript** — ESM is the official JavaScript module system standard
- **Tree-shaking compatibility** — ESM enables static analysis for dead-code elimination
- **Top-level await** — Useful for async initialization in modules
- **TypeScript integration** — TypeScript's `import/export` syntax compiles naturally to ESM
- **Stellar SDK compatibility** — The `@stellar/stellar-sdk` package ships ESM entry points

## Considered Options

| Option | Standard | Dynamic Import | `__dirname` | Interop |
|--------|----------|----------------|-------------|---------|
| ESM (`"type": "module"`) | ECMAScript standard | `import()` | `import.meta.url` | Native |
| CommonJS | Node.js legacy | `require()` | `__dirname` | No native ESM support |

## Decision Outcome

**Chosen option: ESM (`"type": "module"` in `package.json`)**

Rationale:

1. **Standard conformance** — ESM is the official module system of the JavaScript language. CommonJS is a legacy Node.js convention that will not receive new features.
2. **Stellar SDK alignment** — `@stellar/stellar-sdk` and its dependencies ship ESM. Mixing ESM and CJS causes interop issues (wrapped default exports, synthetic namespaces).
3. **Static analysis** — ESM `import` statements are statically analyzable, enabling TypeScript compiler optimizations and IDE tooling improvements.
4. **Future-proofing** — The Node.js ecosystem is converging on ESM. All major frameworks and tools (Vitest, Commander.js, chalk v5, ora v9, pino) ship ESM-first.

### Consequences

- **Positive:** `import` syntax is standard across browsers and Node.js. Contributors familiar with frontend frameworks will find it consistent.
- **Positive:** Top-level `await` is available for initialization code.
- **Negative:** ESM requires explicit file extensions in import paths (e.g., `import { foo } from "./bar.js"`). TypeScript's `moduleResolution: "bundler"` in `tsconfig.json` mitigates this during development, but compiled output must have `.js` extensions.
- **Negative:** Some older npm packages may only provide CommonJS. These are wrapped automatically by Node.js when imported from ESM.
- **Negative:** `__dirname` is not available in ESM. The project uses `import.meta.url` with `fileURLToPath` and `path.dirname` where directory paths are needed.

## Validation

- TypeScript compilation with `"module": "ESNext"` and `"moduleResolution": "bundler"` produces valid ESM output.
- All test files import source modules with explicit `.js` extensions matching TypeScript convention.
- `npx tsc --noEmit` passes in CI without ESM-related errors.
