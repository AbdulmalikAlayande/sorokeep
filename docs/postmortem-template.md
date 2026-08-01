# Incident Postmortem: <!-- TITLE -->

**Date:** YYYY-MM-DD  
**Report author(s):** <!-- @github-handle -->  
**Severity:** <!-- critical / major / minor -->  
**Duration:** <!-- e.g. 34 min, 2h 15min -->  
**Affected contracts:** <!-- contract-id(s), or "all watched" / "none" -->  

---

## Summary

<!--
2–3 sentences in plain language.
What happened? What was the user-visible impact?
-->

---

## Timeline

<!--
Chronological log of key events in UTC.
Include detection, escalation, mitigation, and resolution timestamps.
-->

| Time (UTC) | Event |
|------------|-------|
| HH:MM | <!-- e.g. Alert fired for contract X --> |
| HH:MM | <!-- e.g. Engineer acknowledged page --> |
| HH:MM | <!-- e.g. Daemon restarted --> |
| HH:MM | <!-- e.g. TTL verified healthy --> |

---

## Root Cause

<!--
What underlying defect or condition caused this incident?
Do **not** stop at the proximate trigger — keep asking "why" until you reach a
systemic root cause that can be actioned (code bug, config gap, process miss,
resource limit, external dependency, etc.).
-->

### Sorokeep diagnostic steps

Walk through the evidence collected during the investigation:

1. **Daemon logs** — Review journald or container logs for the affected period.

   ```bash
   journalctl -u sorokeep-daemon --since "YYYY-MM-DD HH:MM" --until "YYYY-MM-DD HH:MM"
   # or, for Docker:
   docker logs sorokeep-daemon --since "YYYY-MM-DDTHH:MM:SSZ"
   ```

   Look for: error traces, unexpected restarts, polling gaps, failed RPC calls,
   or `ExtendFootprintTTLOp`/`RestoreFootprintOp` submission results.

2. **Alert history** — Check whether alerts fired as expected and whether they
   were acknowledged in time.

   ```bash
   sorokeep alerts history --contract <contract-id> --limit 50
   ```

   Look for: missed alerts, delayed delivery, misconfiguration
   (wrong threshold, disabled alert, invalid webhook URL).

3. **Cost & extension history** — Review rent costs and recent extension actions.

   ```bash
   sorokeep costs <contract-id> --period 7
   ```

   Look for: skipped extension cycles, cost spikes, budget exhaustion.

4. **TTL status snapshot** — Check the current state of all watched contracts.

   ```bash
   sorokeep status <contract-id>
   sorokeep check <contract-id> --fail-under 10000
   ```

5. **Database state** — Export and inspect the local SQLite database if
   corruption or state drift is suspected.

   ```bash
   sorokeep db export
   ```

---

## Impact

<!--
Quantify the blast radius. Attach numbers wherever possible.
-->

- **Contracts affected:** <!-- count or IDs -->
- **TTL entries expired / archived:** <!-- number -->
- **Restore operations needed:** <!-- number of `sorokeep restore` invocations -->
- **XLM spent (unexpected):** <!-- amount or "none" -->
- **Downtime for dependent systems:** <!-- e.g. "dApp front-end stale for 12 min" -->
- **User reports / support tickets:** <!-- count -->
- **$ cost (if applicable):** <!-- estimated overage -->

---

## What Went Well

<!--
Honest assessment of what helped contain or resolve the incident.
- Fast detection via <channel>
- Clear runbook for <procedure>
- Good communication in <slack-channel>
-->

---

## What Went Wrong

<!--
Gaps that made the incident worse or longer than necessary.
- Missing alert for <condition>
- No runbook for <procedure>
- Manual step that should be automated
- Insufficient test coverage of <code path>
-->

---

## Action Items

<!--
Specific, owner-assigned, tracked work items. Leave the Tracker column
blank until the item is filed.
-->

| # | Action | Owner | Tracker |
|---|--------|-------|---------|
| 1 | <!-- e.g. Add alert for TTL < 5000 on all prod contracts --> | @handle | #issue |
| 2 | <!-- e.g. Fix polling-interval jitter bug in core/extension.ts --> | @handle | #issue |
| 3 | <!-- e.g. Write troubleshooting runbook for daemon crashloop --> | @handle | #issue |
| 4 | <!-- e.g. Schedule postmortem review for YYYY-MM-DD --> | @handle | <!-- link --> |

### Related security considerations

If this incident involved secret-key exposure, webhook bypass, or RPC trust
boundaries, follow the disclosure procedure in [`SECURITY.md`](../SECURITY.md)
and file a security advisory.
