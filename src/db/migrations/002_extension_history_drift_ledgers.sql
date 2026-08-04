-- Migration 002: add drift_ledgers column to extension_history (issue #495)
--
-- Records the signed ledger delta between the actual post-extension TTL and the
-- policy's target_ttl_ledgers. NULL for pre-migration rows.
-- Positive = exceeded target; negative = fell short.

ALTER TABLE extension_history ADD COLUMN drift_ledgers INTEGER;
