# Changelog

## 0.1.0 (initial stub)

- New `TtlCodeLensProvider` that detects 56-char `C`-prefixed Stellar contract IDs
  in open files and, for contracts tracked by the local sorokeep SQLite database,
  renders an inline TTL/expiry CodeLens (OK / WARNING / CRITICAL / EXPIRED).
- Read-only DB access via `better-sqlite3` (WAL-safe `readonly` mode, optional
  `immutable` fallback), with graceful no-lens degradation on missing/locked DB.
- Matches sorokeep's TTL severity thresholds and ledger-time formatting.
- Unit tests cover detection, classification, DB lookup (fixture DB), and the
  provider — including the "untracked contract shows no CodeLens" acceptance case.