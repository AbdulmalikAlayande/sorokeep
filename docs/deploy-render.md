# Deploying Sorokeep to Render.com

This guide explains how to deploy the Sorokeep daemon (`sorokeep daemon`) to Render.com using the Dockerfile. 

Sorokeep runs as a long-running daemon that polls your monitored contracts. Because it doesn't need to accept incoming HTTP traffic, Render's **Background Worker** service type is the most cost-effective and secure fit. However, if you plan to scrape Prometheus metrics from your daemon, you can deploy it as a **Web Service** instead.

---

## Architecture & Persistence

Sorokeep uses a SQLite database to track monitored contracts, entry states, and alert histories. Render containers are ephemeral, so you **must** configure a Persistent Disk to prevent data loss when the service is restarted or redeployed.

- **SQLite Database Location:** `/home/sorokeep/.sorokeep/sorokeep.db`
- **Volume Mount Path:** `/home/sorokeep/.sorokeep`

---

## Option A: One-Click Deploy (Blueprints)

Render Blueprints allow you to define and manage your infrastructure as code using a `render.yaml` file. We provide a blueprint at `devops/render/render.yaml`.

1. Commit and push the blueprint to your repository: `devops/render/render.yaml`
2. Go to the **Blueprints** section in the Render Dashboard and click **New Blueprint Instance**.
3. Connect your repository. Render will automatically detect the blueprint and configure the Background Worker with a 1 GB persistent disk.
4. Fill in any required environment variables (e.g. `SOROKEEP_TELEGRAM_BOT_TOKEN`, `SOROKEEP_SLACK_TOKEN`) and click **Apply**.

---

## Option B: Manual Dashboard Deployment

If you prefer to configure the service manually via the Render Dashboard:

1. Click **New +** and select **Background Worker**.
2. Connect your Git repository.
3. Configure the following settings:
   - **Name:** `sorokeep-daemon`
   - **Region:** Choose a region close to your Stellar RPC node
   - **Runtime:** `Docker`
   - **Docker Command:** `daemon --network testnet` *(This runs the entrypoint with daemon arguments)*
4. Under **Advanced Settings**, add a **Disk**:
   - **Name:** `sorokeep-data`
   - **Mount Path:** `/home/sorokeep/.sorokeep`
   - **Size:** `1 GB` (Plenty for SQLite)
5. Add your environment variables (see below).
6. Click **Create Background Worker**.

---

## Environment Variables Reference

Configure these in the Render dashboard under your service's **Environment** tab:

| Variable | Type | Description |
|---|---|---|
| `SOROKEEP_TELEGRAM_BOT_TOKEN` | string | Token for Telegram alert delivery |
| `SOROKEEP_SLACK_TOKEN` | string | Incoming Slack webhook URL for Slack alert delivery |
| `SOROKEEP_SMTP_HOST` | string | SMTP server hostname for email alerts |
| `SOROKEEP_SMTP_PORT` | number | SMTP server port |
| `SOROKEEP_SMTP_USER` | string | SMTP authentication username |
| `SOROKEEP_SMTP_PASS` | string | SMTP authentication password |
| `SOROKEEP_MATRIX_ACCESS_TOKEN` | string | Access token for Matrix alert delivery |
| `SOROKEEP_MATRIX_HOMESERVER` | string | Matrix homeserver URL |
| `SOROKEEP_METRICS_TOKEN` | string | Bearer token for accessing metrics/MCP endpoints |
| `SOROKEEP_OTLP_ENDPOINT` | string | OpenTelemetry collector endpoint for tracing |

---

## Initializing & Managing Monitored Contracts

When Sorokeep starts for the first time, its database on the persistent disk is blank. Since it's a Background Worker, it won't watch any contracts by default. You need to register the contracts you want to monitor.

Use Render's web **Shell** tab or SSH into the container to configure the service:

1. Open the **Shell** tab of your Background Worker in the Render dashboard.
2. Run the `watch` command to start tracking a contract:
   ```bash
   node dist/index.js watch <CONTRACT_ID> --network testnet --name my-smart-contract
   ```
3. Add alert configurations to the contract:
   ```bash
   node dist/index.js alerts add --contract <CONTRACT_ID> --type telegram --channel <CHAT_ID> --threshold 1000
   ```
4. Verify the database configuration:
   ```bash
   node dist/index.js status <CONTRACT_ID>
   ```

Because your data directory `/home/sorokeep/.sorokeep` is backed by a persistent disk, these configurations will persist across all subsequent daemon deploys and restarts.

---

## Alternative: Deploying with Prometheus Metrics (Web Service)

If you configure `--metrics-port` (e.g. `--metrics-port 9090` or `SOROKEEP_METRICS_TOKEN`), Render needs to route inbound HTTP traffic to the metrics scrape endpoint. In this case, deploy as a **Web Service** instead of a Background Worker:

- **Service Type:** Web Service
- **Runtime:** Docker
- **Docker Command:** `daemon --network testnet --metrics-port 9090`
- **Port:** `9090`
- **Persistent Disk:** Same setup (Mount Path `/home/sorokeep/.sorokeep`, 1 GB)
