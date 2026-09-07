-- Migration 011: per-transaction fee ceiling on extension policies (issue #420)
--
-- Adds max_fee_stroops to extension_policies. When set, runAutoExtensions
-- (src/core/extension.ts) simulates the extension first and refuses to
-- submit if the estimated fee exceeds this ceiling.
--
-- NULL means "no ceiling" — existing policies are unaffected.

ALTER TABLE extension_policies ADD COLUMN max_fee_stroops INTEGER;
