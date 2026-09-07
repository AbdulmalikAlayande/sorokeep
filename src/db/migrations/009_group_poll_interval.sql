-- Migration 009: group-level default poll interval (issue #400)
--
-- Adds poll_interval_seconds to contract_groups, consulted by
-- resolvePollIntervalMs (src/daemon/loop.ts) as a fallback tier between
-- the per-contract override (contracts.poll_interval_seconds) and the
-- global --interval flag:
--
--   per-contract override  >  per-group default  >  global --interval
--
-- NULL means "this group has no default" — contracts in it fall through
-- to the global interval unless they have their own override.

ALTER TABLE contract_groups ADD COLUMN poll_interval_seconds INTEGER;
