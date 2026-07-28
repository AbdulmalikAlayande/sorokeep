# Sorokeep vs. Cron Script

The most common alternative to Sorokeep isn't a competing product — it's a homegrown cron job calling `soroban contract extend`. This page compares the tradeoffs of each approach.

## Comparison Table

| Feature | Cron Script | Sorokeep |
|---------|-------------|----------|
| **Failure Handling** | Manual — script fails silently or requires custom retry logic | Built-in retry with exponential backoff, graceful failure after 5 attempts |
| **Alerting** | Custom implementation needed (webhook, Slack, etc.) | Multi-channel alerts (Webhook, Slack, Discord, Telegram, PagerDuty) with HMAC signing |
| **Cost Visibility** | No tracking — requires manual ledger inspection or custom logging | Full cost tracking: per-extension XLM costs, 30-day projections, monthly budgets |
| **Multi-Channel Accounts** | Manual sequence number management, single bottleneck | Built-in channel account management for concurrent submissions |
| **Audit Trail** | None unless you build it | Complete history: all extensions, alerts fired, delivery status, resolution tracking |
| **Setup Time** | 2-4 hours (script, cron, alerting, monitoring) | 5-10 minutes (`sorokeep watch`, `sorokeep alerts add`, `sorokeep daemon`) |
| **Maintenance Burden** | High — you own the code, bugs, and edge cases | Low — battle-tested with 891 tests, handles edge cases automatically |
| **Threshold Escalation** | Manual — requires custom logic for multiple thresholds | Automatic — supports multiple thresholds per contract with severity levels |
| **Transaction Simulation** | Optional — you must implement it yourself | Mandatory — simulates before every extend/restore to prevent failed submissions |
| **State Recovery** | Manual — you must detect and trigger restores | Automatic — detects archived entries and can restore via `sorokeep restore` |
| **Network Failures** | Script crashes or hangs | Resilient — isolated error handling per phase, daemon continues running |
| **Configuration** | Hardcoded or scattered config files | Centralized config at `~/.sorokeep/config.yaml` with env var support |
| **Security** | You must implement secret key management safely | Secrets never stored in DB; env var resolution at runtime; integrates with AWS Secrets Manager & HashiCorp Vault |
| **Observability** | Whatever you build | Structured JSON logging, alert history, resource usage logs, cost projections |
| **Footprint Discovery** | Manual — you must track storage keys yourself | Automatic — discovers from on-chain transactions, introspection specs, or manual declaration |

## When a Cron Script Is Sufficient

A simple cron script may be the right choice if:

- **Single contract** — You only have one Soroban contract to monitor
- **Generous TTL margins** — Your contract has very long TTLs (months) and low extension frequency
- **No team to alert** — You're the only operator and don't need notifications
- **No cost tracking** — You don't care about XLM spend projections or budgets
- **Comfort with maintenance** — You're willing to debug script failures, implement retry logic, and handle edge cases
- **No audit requirements** — You don't need a historical record of extensions or alerts

In this scenario, a 50-line cron script calling `soroban contract extend` every week might be simpler than running a full daemon.

## When Sorokeep Is Worth It

Sorokeep pays for itself quickly if:

- **Multiple contracts** — You're managing 3+ contracts and need centralized monitoring
- **Team operations** — Multiple people need visibility into TTL health and costs
- **Production requirements** — You need reliable alerting, retry logic, and audit trails
- **Cost sensitivity** — You want to track XLM spend, enforce budgets, and project costs
- **Complex storage** — Your contract uses many persistent storage entries that need discovery
- **Incident response** — You need to restore archived entries quickly when things go wrong
- **Security compliance** — You need proper secret key management and audit logs

The setup time difference (5-10 minutes vs. 2-4 hours) is often recovered in the first incident that Sorokeep handles automatically.

## The Hidden Costs of "Simple"

A cron script looks simple at first, but the real complexity emerges over time:

- **RPC failures** — What happens when the Stellar RPC is rate-limited or down?
- **Sequence number conflicts** — How do you handle concurrent submissions from multiple cron jobs?
- **Failed transactions** — Do you simulate before submitting? How do you handle insufficient fees?
- **Threshold logic** — What if TTL drops faster than expected? Do you have multiple alert thresholds?
- **Alert delivery** — What if your webhook endpoint is down? Do you retry? How many times?
- **State drift** — How do you know your script's view of TTLs matches the network?
- **Debugging** — When something breaks at 3 AM, do you have logs to understand what happened?

Sorokeep has already solved these problems. The 891 tests cover edge cases you might not even know exist.

## Cost Comparison

Assuming a developer cost of $100/hour:

| Approach | Initial Setup | Annual Maintenance | First Year Total |
|----------|---------------|-------------------|------------------|
| Cron Script | 4 hours = $400 | 8 hours/year = $800 | $1,200 |
| Sorokeep | 0.25 hours = $25 | 1 hour/year = $100 | $125 |

The maintenance gap widens over time as you encounter edge cases, add more contracts, or need new features.

## Conclusion

For a single contract with simple requirements, a cron script can work. But as soon as you add a second contract, need reliable alerting, or want to understand your costs, the maintenance burden of a homegrown solution grows quickly.

Sorokeep is the operations layer that lets you focus on building contracts, not babysitting them.
