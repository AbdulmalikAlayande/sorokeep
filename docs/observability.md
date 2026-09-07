# Observability Setup: Prometheus + Grafana

This guide walks through connecting sorokeep's built-in metrics endpoint to a Prometheus + Grafana observability stack, alerting on it via Alertmanager, and running the whole thing via Docker Compose.

## Prerequisites

- A running sorokeep daemon (`sorokeep daemon`)
- [Prometheus](https://prometheus.io/download/) 2.x+
- [Grafana](https://grafana.com/grafana/download/) 10.x+
- Network connectivity between Prometheus and the sorokeep host

## 1. Enable the Metrics Server

Start the daemon with the `--metrics-port` flag to expose a Prometheus-format `/metrics` endpoint:

```bash
sorokeep daemon --network testnet --metrics-port 9464
```

The metrics server also exposes `/readyz` — a readiness probe returning 200 when the database and configured Stellar RPC endpoint are both reachable, 503 (with a JSON body naming the failing dependency) otherwise.

You can verify the endpoint is working:

```bash
curl http://localhost:9464/metrics
```

Sample output (trimmed — the exact set of `# HELP`/`# TYPE` blocks grows as new metrics land; run the command above against your own instance for the full, current list):

```
# HELP sorokeep_contracts_tracked Number of contracts currently being watched
# TYPE sorokeep_contracts_tracked gauge
sorokeep_contracts_tracked{network="testnet"} 3

# HELP sorokeep_entries_tracked Number of contract entries currently being tracked
# TYPE sorokeep_entries_tracked gauge
sorokeep_entries_tracked{network="testnet"} 10

# HELP sorokeep_extensions_total Cumulative count of TTL-extension transactions, partitioned by contract and entry type.
# TYPE sorokeep_extensions_total counter
sorokeep_extensions_total{contract_id="C...",entry_type="instance"} 42

# HELP sorokeep_extension_cost_xlm_total Cumulative XLM cost of all TTL-extension transactions, partitioned by contract and entry type.
# TYPE sorokeep_extension_cost_xlm_total counter
sorokeep_extension_cost_xlm_total{contract_id="C...",entry_type="instance"} 1.5
```

### Metrics Port Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--metrics-port` | Disabled | Port for the Prometheus metrics HTTP server. Binds to `127.0.0.1` only — put a reverse proxy in front if Prometheus runs on a different host. |
| `SOROKEEP_METRICS_TOKEN` (env var) | Unset | When set, `/metrics` and `/readyz` require a matching `Authorization: Bearer <token>` header. Unset by default — intended for localhost/private-network use. |

## 2. Configure Prometheus to Scrape sorokeep

Create or edit `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'sorokeep'
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: /metrics
    static_configs:
      - targets:
          - 'localhost:9464'
        labels:
          service: sorokeep
          network: testnet
```

Replace `localhost` with the sorokeep host address if Prometheus is running on a different machine. If sorokeep runs in a Docker container, use the container name or host's Docker bridge IP.

Start Prometheus with the config:

```bash
prometheus --config.file=prometheus.yml
```

Verify targets are up at `http://localhost:9090/targets` — the `sorokeep` job should show `UP`.

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `sorokeep_contracts_tracked` | Gauge | Contracts currently being watched, labelled by `network` |
| `sorokeep_entries_tracked` | Gauge | Contract entries currently being tracked, labelled by `network` |
| `sorokeep_entry_ttl_remaining_ledgers` | Gauge | Remaining TTL per tracked entry, labelled by `contract_id`, `contract_name`, `entry_type`, `network` |
| `sorokeep_extensions_total` | Counter | Cumulative count of TTL-extension transactions, labelled by `contract_id`, `entry_type` |
| `sorokeep_extension_cost_xlm_total` | Counter | Cumulative XLM cost of TTL-extension transactions, labelled by `contract_id`, `entry_type` |
| `sorokeep_budget_remaining_xlm` | Gauge | Remaining XLM budget headroom, labelled by `contract_id`, `network` |
| `sorokeep_daemon_cycle_duration_seconds` | Histogram | Duration of each completed daemon monitor cycle, labelled by `network` |
| `sorokeep_daemon_cycles_skipped_total` | Counter | Scheduled ticks skipped because the previous cycle was still in flight, labelled by `network` |

Run `sorokeep metrics` (see below) or `curl` the endpoint directly to see the exact, current set for your build — this table will drift as new metrics land, but the CLI/HTTP output is always authoritative.

You can also print this same snapshot without running a server at all:

```bash
sorokeep metrics            # Prometheus exposition text
sorokeep metrics --json     # structured JSON
```

## 3. Build a Grafana Dashboard

A ready-to-import dashboard JSON lives at [`devops/grafana/sorokeep-dashboard.json`](../devops/grafana/sorokeep-dashboard.json) — import it directly via Grafana's **Dashboards → Import** screen, or use it as a starting point. It covers fleet overview, TTL-over-time, extension activity/cost, and daemon health, all against the metric names from the table above. Each metric is a standard Prometheus gauge/counter/histogram, so any panel type (stat, time series, heatmap for the histogram) works with a plain PromQL query against them. A few starting points:

| Panel idea | Example PromQL |
|-------|-------------|
| Watched contracts | `sorokeep_contracts_tracked` |
| Entries tracked | `sorokeep_entries_tracked` |
| Extension cost rate (1h) | `rate(sorokeep_extension_cost_xlm_total[1h])` |
| Extensions performed (1h) | `rate(sorokeep_extensions_total[1h])` |
| Daemon cycle duration (p95) | `histogram_quantile(0.95, rate(sorokeep_daemon_cycle_duration_seconds_bucket[5m]))` |
| Skipped daemon cycles | `sorokeep_daemon_cycles_skipped_total` |
| Remaining TTL per entry | `sorokeep_entry_ttl_remaining_ledgers` |
| Remaining budget | `sorokeep_budget_remaining_xlm` |

## 4. Alerting with Alertmanager

### Example Alert Rules

A ready-to-use rules file with these examples (plus a couple more) lives at [`devops/prometheus/sorokeep-alerts.yml`](../devops/prometheus/sorokeep-alerts.yml) — copy it directly or use it as a starting point.

Create `sorokeep_alerts.yml`:

```yaml
groups:
  - name: sorokeep
    rules:
      - alert: SorokeepDown
        expr: up{job="sorokeep"} == 0
        for: 1m
        annotations:
          summary: "sorokeep instance {{ $labels.instance }} is down"
          description: "Prometheus target {{ $labels.job }}/{{ $labels.instance }} has been unreachable for over 1 minute."

      - alert: SorokeepDaemonCyclesSkipped
        expr: increase(sorokeep_daemon_cycles_skipped_total[10m]) > 0
        for: 0m
        annotations:
          summary: "sorokeep daemon cycles are falling behind on {{ $labels.network }}"
          description: "The daemon has skipped {{ $value }} scheduled cycle(s) in the last 10 minutes because the previous cycle was still running — the fleet may have grown too large for the configured poll interval."

      - alert: SorokeepExtensionCostSpike
        expr: rate(sorokeep_extension_cost_xlm_total[1h]) > 1
        for: 10m
        annotations:
          summary: "High extension cost rate detected"
          description: "XLM extension cost rate is {{ $value }} XLM/hour — investigate unusual extension activity."
```

Include this file in your `prometheus.yml`:

```yaml
rule_files:
  - 'sorokeep_alerts.yml'
```

### Wiring to Alertmanager

Configure Alertmanager to route sorokeep alerts to your preferred channels (email, Slack, PagerDuty, etc.):

```yaml
# alertmanager.yml
route:
  group_by: ['alertname']
  receiver: 'slack-team'
  routes:
    - match:
        alertname: 'SorokeepDown'
      receiver: 'pagerduty-ops'

receivers:
  - name: 'slack-team'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/...'
        channel: '#sorokeep-alerts'
```

## 5. Docker Compose (Full Stack)

For a complete local observability stack including Prometheus, Grafana, and Alertmanager alongside sorokeep:

```yaml
version: "3.8"

services:
  sorokeep:
    build: .
    command: ["sorokeep", "daemon", "--network", "testnet", "--metrics-port", "9464"]
    ports:
      - "9464:9464"
    volumes:
      - sorokeep-data:/root/.sorokeep
    restart: unless-stopped

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./sorokeep_alerts.yml:/etc/prometheus/sorokeep_alerts.yml
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:latest
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
    restart: unless-stopped

volumes:
  sorokeep-data:
  grafana-data:
```

### Pre-Wired Profile (Prometheus + Grafana, Zero Manual Config)

If you'd rather not hand-assemble the compose file above, `docker-compose.observability.yml` is a ready-to-use overlay with Prometheus and Grafana already pre-wired to scrape sorokeep and auto-provision the dashboard from [§3](#3-build-a-grafana-dashboard) — no manual `prometheus.yml` editing or dashboard import required:

```sh
docker compose -f docker-compose.yaml -f docker-compose.observability.yml --profile observability up
```

Prometheus is available at `http://localhost:9090` and Grafana at `http://localhost:3000`. Grafana uses `admin` / `admin` by default (override with `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`) and provisions the **Sorokeep Overview** dashboard automatically. Prometheus scrapes the sorokeep metrics endpoint at `sorokeep:9464` within the Compose network.

## 6. Troubleshooting

### Scrape Target Down

**Symptom:** Prometheus shows `sorokeep` target as `DOWN`.

**Causes and fixes:**

| Cause | Check | Fix |
|-------|-------|-----|
| Metrics port not exposed | `curl http://localhost:9464/metrics` on the sorokeep host | Verify `--metrics-port` is set |
| Firewall blocking | `nc -zv <host> 9464` from the Prometheus host | Open port 9464 in the firewall / security group |
| Container networking | `docker ps` and check sorokeep container port mapping | Add `ports: - "9464:9464"` to the compose service |
| sorokeep not running | `systemctl status sorokeep` or check process list | Restart the daemon |
| Prometheus config error | `promtool check config prometheus.yml` | Fix any syntax errors |

### No Metrics Data

**Symptom:** Target is `UP` but no metrics appear in Prometheus or Grafana panels are empty.

- Ensure the daemon has been running long enough to collect data (at least one monitor cycle)
- Check `http://localhost:9464/metrics` directly — if metrics show zero values, the daemon hasn't completed a cycle yet
- Verify the Prometheus `metrics_path` matches the endpoint (default `/metrics`)

### High Scrape Latency

**Symptom:** Prometheus scrape durations are > 10s.

For large deployments with many contracts, increase the scrape interval in `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'sorokeep'
    scrape_interval: 30s
    scrape_timeout: 15s
```

### Grafana Panels Show "No Data"

**Symptom:** The imported dashboard (see [§3](#3-build-a-grafana-dashboard)) loads, but panels are empty.

- Confirm the dashboard's Prometheus datasource variable points at the same Prometheus instance scraping sorokeep — it's prompted for on import.
- Check the `$network` and `$contract` template variables at the top of the dashboard aren't filtered to a value with no matching series.
