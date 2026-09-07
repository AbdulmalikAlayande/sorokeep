# Deploying sorokeep on Fly.io

This guide deploys one always-on sorokeep daemon to Fly.io. Its SQLite
database is stored on a Fly Volume, so watched contracts, alerts, and daemon
state survive Machine restarts.

## Prerequisites

- A [Fly.io account](https://fly.io/app/sign-up) with billing enabled for the
  resources you choose.
- The [Fly CLI (`flyctl`)](https://fly.io/docs/flyctl/install/) installed and
  authenticated with `fly auth login`.
- A checkout of this repository and Docker available locally if you want to
  build locally. Fly can also perform the build remotely.

## 1. Create the Fly app

From the repository root, create an app without deploying the generated
configuration yet:

```bash
fly launch --no-deploy
```

Choose a region close to your team or RPC provider. Fly creates a globally
unique app name during this step. Copy the sorokeep template over the generated
configuration, then put that app name in the `app` field (and adjust
`primary_region` if you chose a different region):

```bash
cp devops/fly/fly.toml fly.toml
# Edit fly.toml: replace sorokeep-your-app-name with the name from `fly launch`.
```

The template runs `sorokeep daemon --network testnet` and mounts the
`sorokeep_data` volume at `/home/sorokeep/.sorokeep`, the database directory
used by the Docker image. Do not run multiple daemon Machines against this
single SQLite volume. To monitor mainnet, change the process command to
`daemon --network mainnet` before deploying.

## 2. Set secrets

The template uses sorokeep's built-in testnet RPC endpoint and five-minute
polling interval. If you have already configured an auto-extension policy that
reads its key from `STELLAR_SECRET_KEY`, store that key only as a Fly secret:

```bash
fly secrets set STELLAR_SECRET_KEY='S...'
```

Never put Stellar secret keys in `fly.toml`, a committed `.env` file, or shell
history. `fly secrets set` updates Machines, so setting secrets before the
first deploy is expected. For a custom RPC URL or polling interval, add
`--rpc-url <url>` or `--interval <milliseconds>` to the `daemon` process
command in `fly.toml`, then deploy the changed configuration. These daemon
options are command-line settings; this release does not read them from
environment variables.

## 3. Deploy and confirm the daemon is running

Deploy the Docker image and create the `sorokeep_data` volume declared in the
template:

```bash
fly deploy
```

Confirm the Machine is running and follow its logs:

```bash
fly status
fly logs
```

The logs should show the daemon starting and beginning monitor cycles. The
template intentionally has no HTTP service: sorokeep is a background worker,
not a web server.

## 4. Watch a testnet contract

The daemon monitors contracts that have been registered in its local database.
Run `watch` once inside the deployed Machine; it writes to the same mounted
database used by the daemon:

```bash
fly ssh console -C \
  'node /app/dist/index.js watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --network testnet --name "XLM Native Token"'
```

Verify the stored monitoring state:

```bash
fly ssh console -C \
  'node /app/dist/index.js status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
fly logs
```

You should see the watched contract's TTL status and subsequent daemon monitor
cycles in the logs. If `watch` cannot reach the RPC endpoint, update the
`--rpc-url` value in the daemon process command (or remove it to use the
built-in testnet endpoint), run `fly deploy`, and repeat the command.

## Operations

```bash
# Inspect Machine state and recent logs
fly status
fly logs

# Restart after changing non-secret fly.toml settings
fly deploy

# Open a shell for diagnosis
fly ssh console
```

Fly volumes are tied to a region. Back up the database before deleting the
Machine or volume, and keep the app in the volume's region unless you migrate
the data intentionally. See the [Fly Volume documentation](https://fly.io/docs/volumes/overview/)
for backup and migration options.
