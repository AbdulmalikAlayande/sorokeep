# PagerDuty Escalation Policy Template for Sorokeep

This guide walks you through setting up a PagerDuty service, configuring an escalation policy tailored for smart contract TTL health, and connecting it to Sorokeep via the PagerDuty Events API v2.

---

## Overview

Sorokeep delivers alerts directly to PagerDuty's [Events API v2](https://developer.pagerduty.com/docs/events-api-v2/overview/). When a monitored Soroban contract crosses a TTL threshold or consumes excessive resources, Sorokeep triggers an incident with structured metadata (network, entry type, TTL remaining, and Stellar.expert link). Once the contract is extended or restored, Sorokeep sends an automated resolution event that closes the incident without manual intervention.

---

## Escalation Policy Design for Smart Contract TTLs

Smart contract storage expiration is time-sensitive. If a contract instance or persistent storage expires, transactions fail immediately and restoration costs time and XLM. A recommended 3-tier escalation policy:

```
[Sorokeep Alert Triggered]
           │
           ▼
┌──────────────────────────────────────┐
│  Tier 1: Primary On-Call Engineer    │  Notify immediately via Push / SMS / Phone
│  (Acknowledge within 15 minutes)     │
└──────────────────┬───────────────────┘
                   │ Unacknowledged after 15 min
                   ▼
┌──────────────────────────────────────┐
│  Tier 2: Secondary / Backup On-Call  │  Escalate to secondary responder
│  (Acknowledge within 15 minutes)     │
└──────────────────┬───────────────────┘
                   │ Unacknowledged after 15 min
                   ▼
┌──────────────────────────────────────┐
│  Tier 3: Engineering Lead / DevOps   │  Page team lead / emergency channel
└──────────────────┬───────────────────┘
                   │
                   ▼ (Repeat whole policy up to 3 times if unresolved)
```

### Policy Structure

| Escalation Level | Target | Notification Rules | Escalation Delay |
|---|---|---|---|
| **Level 1 (Immediate)** | Primary On-Call Rotation | Push notification + SMS + Phone call | 15 minutes |
| **Level 2 (Backup)** | Secondary On-Call Rotation | Push notification + SMS + Phone call | 15 minutes |
| **Level 3 (Emergency)** | DevOps Lead / Engineering Manager | High-urgency Phone call & Email | Repeat 2-3 times |

---

## Step 1: Create the Escalation Policy in PagerDuty

1. Log into your PagerDuty account.
2. Navigate to **People** > **Escalation Policies** and click **New Escalation Policy**.
3. Set the name: `Soroban Smart Contract Storage Policy`.
4. Configure the levels:
   - **Level 1:** Add your primary on-call schedule or engineer. Set *Escalate after* to `15` minutes.
   - **Level 2:** Add your secondary backup engineer or schedule. Set *Escalate after* to `15` minutes.
   - **Level 3:** Add your DevOps/Engineering lead.
5. Under **Repeat Policy**, set *If no one acknowledges, repeat the policy* to `3` times.
6. Click **Save**.

---

## Step 2: Create a PagerDuty Service & Generate Integration Key

1. Go to **Services** > **Service Directory** and click **New Service**.
2. **Name:** `Soroban TTL Monitor` (or your specific contract name).
3. **Escalation Policy:** Select `Soroban Smart Contract Storage Policy` (created in Step 1).
4. **Reduce Noise / Alert Grouping:** Select *Intelligent* or *Content-based* (Sorokeep already provides deterministic `dedup_key` values).
5. **Integrations:** Search for and select **Events API v2**.
6. Click **Create Service**.
7. Copy the **Integration Key** (a 32-character hexadecimal string, e.g. `d41d8cd98f00b204e9800998ecf8427e`).

---

## Step 3: Configure Sorokeep Alert Channel

In your terminal, add the PagerDuty integration key to your monitored contract using the `--routing-key` flag:

```bash
sorokeep alerts add \
  --contract CA3D5KRYMCM5OXN... \
  --type pagerduty \
  --routing-key "YOUR_PAGERDUTY_INTEGRATION_KEY" \
  --threshold 20000
```

- `--type pagerduty`: Specifies the PagerDuty Events API v2 channel.
- `--routing-key`: Your PagerDuty Integration Key generated in Step 2.
- `--threshold 20000`: Triggers an incident when the remaining TTL drops below 20,000 ledgers (~27 hours).

---

## Severity Mapping & Incident Urgency

Sorokeep maps its internal alert events to PagerDuty severity levels based on `src/alerts/pagerduty.ts`:

| Sorokeep Event Condition | Sorokeep Severity | PagerDuty Severity | PagerDuty Action |
|---|---|---|---|
| TTL < Critical Threshold or Resource Max Exceeded | `critical` | `critical` | High Urgency Incident (triggers immediate phone/SMS paging) |
| TTL < Warning Threshold | `warning` | `warning` | Standard Urgency Incident |
| TTL Extended Above Threshold / Recovered | `resolved` | `info` | `event_action: "resolve"` (automatically resolves the incident) |

### Deduplication & Auto-Resolution

Sorokeep constructs a deterministic deduplication key for each entry:
```
sorokeep:<network>:<contractId>:<entryKey>:<threshold>
```
- **Alert Grouping:** Multiple alerts fired for the same threshold will update the existing incident rather than spamming duplicate tickets.
- **Automated Close:** When the Sorokeep daemon detects that a TTL extension has occurred and the TTL is back above the threshold, it sends a payload with `event_action: "resolve"` using the same deduplication key, automatically resolving the PagerDuty incident.

---

## Step 4: Verify the Integration

You can test that your PagerDuty integration and escalation rules work using `sorokeep alerts test`:

### Dry Run (Inspect Payload without sending)
```bash
sorokeep alerts test --id <ALERT_CONFIG_ID> --dry-run
```

### Live Test (Trigger real PagerDuty test alert)
```bash
sorokeep alerts test --id <ALERT_CONFIG_ID>
```

You should see:
```text
Sending test alert to pagerduty:...
Test alert delivered successfully.
```
And an incident will appear on your PagerDuty dashboard and page the Level 1 responder.
