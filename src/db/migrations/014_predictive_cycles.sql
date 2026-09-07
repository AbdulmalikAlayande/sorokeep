-- Migration 014: add predictive_cycles column (issue #492)
--
-- Adds the predictive_cycles column to extension_policies (contract-level
-- setting) and guard_policy_history (so rollback restores it correctly).
-- On a fresh database created from the current schema.sql, both columns
-- already exist — the Migrator swallows the resulting "duplicate column
-- name" error for pure ADD COLUMN migrations and still marks this applied.

ALTER TABLE extension_policies ADD COLUMN predictive_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guard_policy_history ADD COLUMN predictive_cycles INTEGER NOT NULL DEFAULT 0;
