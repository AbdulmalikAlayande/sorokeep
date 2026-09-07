# Sorokeep TTL CodeLens (VS Code extension — stub)

Shows the current TTL / expiry status of a Stellar **contract ID** inline in the
editor, read **read-only** from the local sorokeep SQLite database. When you
reference a watched contract in your code, a CodeLens above it reports how much
TTL its storage has left and whether it is `OK`, `WARNING`, or `CRITICAL` —
matching sorokeep's own severity thresholds, so you can see at a glance whether
the contract you're about to work against is about to expire.

This is an exploratory stub (sorokeep issue #437). It is intentionally
**read-only**: it never writes to the sorokeep database and makes no changes to
sorokeep itself.

## How the status is computed

Exactly like sorokeep's `sorokeep status` command:

- Remaining TTL = `live_until_ledger − last_checked_ledger` (per contract entry,
  read from the local DB).
- Bucket thresholds mirror `src/utils/formatting.ts` `classifyTTL`:
  - `≤ 0` → **expired**
  - `< 5,000` ledgers → **critical**
  - `< 20,000` ledgers → **warning**
  - otherwise → **ok**
- Human-readable time (`~14h 30m`) mirrors `formatTimeToCloseLedger` (5.5 s per
  ledger).
- The lens shows the **most urgent** entry for the contract (minimum remaining TTL).

## Read-only database safety

A running sorokeep daemon writes to the DB in **WAL mode**. The extension opens
the database with `better-sqlite3` using `fileMustExist: true` and `readonly: true`,
so it never forkers with the daemon writer and never attempts a write. If even a
read-only WAL open is blocked (read-only filesystem, locked `-shm`), you can set
`sorokeep.dbReadMode: immutable` to read just the single `.db` file — safe, but the
last WAL checkpoint's uncommitted data may be missed. On *any* failure to open or
query, the extension simply shows no CodeLens (it never throws or spams errors).
Contract IDs that sorokeep does **not** track produce no CodeLens.

## Install & run

Prereqs: Node 20+, VS Code 1.90+.

This is a stub; it ships as a `.vsix` you install locally, or you can launch it
from a Dev Container that can see the host `~/.sorokeep` DB.

```bash
cd vscode-extension
npm install
# 1) typecheck + unit tests first
npm run typecheck && npm test
# 2) package and install into VS Code
npm run compile
npx @vscode/vsce package
code --install-extension sorokeep-ttl-codelens-0.1.0.vsix
```

> ⚠️ Native dependency note: `better-sqlite3` is prebuilt for your *Node* ABI, but
> the VS Code extension host runs on Electron's own Node. If the lens never
> appears, run `npm rebuild better-sqlite3` / `npx @vscode/vsce package` from a
> Node version matching Electron, or use the `immutable` read mode — the CodeLens
> logic itself is covered by the unit tests regardless of the native binding.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `sorokeep.dbFilePath` | `${HOME}/.sorokeep/sorokeep.db` | Path to the local sorokeep SQLite database. `\${HOME}` → home dir. |
| `sorokeep.dbReadMode` | `readonly` | `readonly` (WAL-safe) or `immutable` (reads single .db file, ignores WAL). |
| `sorokeep.enableCodeLens` | `true` | Master switch for the provider. |

## Where it works

Any open file with a full 56-char, `C`-prefixed, all-caps contract ID (e.g. a
hardcoded address in a config, a test fixture, a deployed-contract constant).

## Development

```bash
cd vscode-extension
npm install            # first time
npm test               # unit tests (vitest, 31 tests, fixture DB)
npm run typecheck      # tsc --noEmit (src + tests)
npm run lint           # eslint (0 errors; no-explicit-any warnings mirror repo baseline)
npm run compile        # emit ./out for packaging
```

The DB reader is tested against a fixture database matching sorokeep's schema,
and the provider is tested against a stubbed `vscode` namespace, so the two
acceptance criteria are covered without launching the extension host:
- a file containing a **watched** contract ID shows a CodeLens with the correct
  TTL status;
- a file containing an **untracked** contract ID shows no CodeLens.

## Roadmap (honest follow-ups)

- `FileSystemWatcher`/subscription invalidation so lenses refresh when the DB is
  updated by a daemon (currently re-read on each document scan).
- Prefetch + cache on a background interval instead of per-scan open/close.
- Optional read path against a running daemon/observability HTTP endpoint.
- True integration test under the VS Code extension host (`@vscode/test-electron`)
  to exercise the real `better-sqlite3` binding against Electron's ABI.
- VS Code Marketplace publishing (`vsce publish`) once a maintainer is happy with
  placement of this package.