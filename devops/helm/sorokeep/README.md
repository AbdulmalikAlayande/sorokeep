# sorokeep Helm chart

Deploys exactly one instance of the [sorokeep](https://github.com/AbdulmalikAlayande/sorokeep)
Soroban contract TTL monitoring daemon to Kubernetes.

**Read "Exactly one instance" before installing this anywhere that matters.**

## Image prerequisite

No sorokeep container image is published anywhere today. The repository's
CI (`.github/workflows/release.yml`) publishes npm packages, not a
container image, and `.github/workflows/` is out of scope for this chart's
issue — so this chart cannot assume any registry convention exists.

`values.yaml`'s default `image.repository` (`REPLACE_ME/sorokeep`) is
intentionally a non-functional placeholder. Before installing, build the
image from the repository root and push it somewhere you control:

```bash
docker build -t your-registry.example.com/sorokeep:1.0.0 .
docker push your-registry.example.com/sorokeep:1.0.0
```

Then install with `--set image.repository=your-registry.example.com/sorokeep --set image.tag=1.0.0`
(or bake those into your own values file).

## Installation

```bash
helm install sorokeep devops/helm/sorokeep \
  --set image.repository=your-registry.example.com/sorokeep \
  --set image.tag=1.0.0
```

Or with a values file:

```bash
helm install sorokeep devops/helm/sorokeep -f my-values.yaml
```

Uninstall:

```bash
helm uninstall sorokeep
```

Uninstalling does **not** delete the PVC (standard Kubernetes/Helm
behavior for PVCs) — the SQLite database survives a `helm uninstall`.
Delete it explicitly (`kubectl delete pvc sorokeep-data`) if you actually
want to discard the data.

## Configuration

Non-sensitive daemon settings, under `config:` in `values.yaml`:

| Key | Default | Description |
|---|---|---|
| `config.network` | `testnet` | Stellar network to monitor (`mainnet`\|`testnet`\|`standalone`). Passed as `--network`. |
| `config.rpcUrl` | `""` | Custom Soroban RPC endpoint. Passed as `--rpc-url` only when non-empty; otherwise the app uses its own per-network default. |
| `config.pollingIntervalSeconds` | `300` | Polling interval in **seconds** (matches `config.yaml`'s native unit). Converted to milliseconds for the daemon's `--interval` flag, which the app requires to be `>= 10`. |
| `config.templatesPath` | `""` | Directory containing custom Handlebars alert templates. |
| `config.monthlyBudgetXlm` | `null` | Monthly rent budget in XLM (used by the `costs` command). |

Image settings, under `image:`:

| Key | Default | Description |
|---|---|---|
| `image.repository` | `REPLACE_ME/sorokeep` | See "Image prerequisite" above. |
| `image.tag` | `""` (falls back to the chart's `appVersion`) | Image tag. |
| `image.pullPolicy` | `IfNotPresent` | Standard Kubernetes pull policy. |

Persistence settings, under `persistence:` — see "Persistence" below.

There is intentionally **no `replicaCount`** (or similarly named) value —
see "Exactly one instance".

## Secret handling

The application (`src/utils/config.ts`) loads exactly one file,
`~/.sorokeep/config.yaml`, with no include/merge mechanism, and several
fields — `slackToken`, `feeSponsorSecret` — have **no environment
variable fallback**: they can only reach the app through that one file.
Kubernetes can't merge a ConfigMap and a Secret into one mounted file on
its own, so this chart uses a small `merge-config` init container
(`busybox`) to do it:

1. The **ConfigMap** (`templates/configmap.yaml`) holds a non-sensitive
   `config.yaml` fragment (`network`, `pollingIntervalSeconds`, etc).
2. The **Secret** (`templates/secret.yaml`) holds `slackToken`,
   `telegramBotToken`, and `feeSponsorSecret`, each as its own key,
   defaulting to `""`.
3. On every pod start, the init container copies the ConfigMap's
   fragment onto the PVC as `config.yaml`, then appends any Secret key
   that isn't empty. The result is a single, valid `config.yaml` at
   `/home/sorokeep/.sorokeep/config.yaml`, which is what the app expects.

**Never put real secret values in `values.yaml`** (its committed
defaults are always `""`). Supply them at install/upgrade time instead:

```bash
helm upgrade --install sorokeep devops/helm/sorokeep \
  --set secrets.slackToken=xoxb-... \
  --set secrets.feeSponsorSecret=SBBBB...
```

For anything beyond quick testing, prefer a `-f secrets.yaml` file that's
never committed, or have your CD pipeline populate `secrets.*` from a
real secrets manager (Vault, AWS Secrets Manager, sealed-secrets, etc.)
rather than passing raw values on a command line that ends up in shell
history.

Vault (`vault.url`/`vault.token`) and SMTP (`smtp.*`) config fields exist
in the application but are **not wired up by this chart yet** — they're
nested objects that would need the merge script to build nested YAML
rather than flat top-level keys, which was left out to keep this chart's
first version minimal. Adding them is a natural, contained follow-up to
`templates/secret.yaml`, `templates/configmap.yaml`, and the merge
script in `templates/deployment.yaml`.

## Exactly one instance

**This chart cannot be configured to run more than one replica.** The
`Deployment`'s `spec.replicas` is hardcoded to `1` in
`templates/deployment.yaml` and is not wired to any `values.yaml` key —
`--set replicaCount=N` or `--set replicas=N` has no effect, because
nothing in any template reads those keys.

### Why SQLite/WAL prevents horizontal scaling

The daemon opens its database (`src/db/database.ts`) with
`PRAGMA journal_mode = WAL`. WAL mode allows one writer at a time,
coordinated through POSIX file locks (`sorokeep.db-wal`/`sorokeep.db-shm`
alongside the main file) that assume a single host's kernel is
arbitrating access. Running two daemon pods against the same database —
even briefly — risks `SQLITE_BUSY`/`database is locked` errors and, on
storage backends that don't implement POSIX locking faithfully (notably
many `ReadWriteMany`/NFS-backed volumes), silent data corruption. There
is no clustering, replication, or leader-election logic anywhere in the
application to coordinate multiple writers — enforcing single-instance
at the chart level is the only thing standing between this and file
corruption.

## Recreate deployment behavior

The `Deployment` uses `strategy.type: Recreate`, not the Kubernetes
default `RollingUpdate`. `RollingUpdate` brings up the new pod before
tearing down the old one, which — combined with a `ReadWriteOnce` PVC —
would either deadlock (new pod stuck `Pending`, unable to attach the
still-mounted volume) or, on a storage backend that permits it, briefly
run two daemon processes against the same SQLite file. `Recreate`
guarantees the old pod is fully terminated (and its lock on the PVC
released) before the replacement pod is created.

## Persistence

A `PersistentVolumeClaim` (`templates/pvc.yaml`) is always created —
persistence is not optional in this chart, since an ephemeral SQLite
database defeats the purpose of the daemon tracking contract TTL history
over time. It's mounted at `/home/sorokeep/.sorokeep` in both the main
container and the `merge-config` init container — the exact path
`src/db/database.ts` and `src/utils/config.ts` derive from
`os.homedir()` for the container's `sorokeep` user (see the repository
root `Dockerfile`, which creates that user and declares the same path as
a `VOLUME`).

| Key | Default | Description |
|---|---|---|
| `persistence.size` | `1Gi` | PVC storage request. |
| `persistence.storageClassName` | `""` (cluster default) | Override to pin a specific `StorageClass`. |
| `persistence.accessMode` | `ReadWriteOnce` | **Do not change this.** See "Why SQLite/WAL prevents horizontal scaling" above — `ReadWriteMany` is not safe for a WAL-mode SQLite file. |

### A note on file ownership

The Dockerfile creates the container's `sorokeep` user with
`adduser -S` (an Alpine "system" account), which is assigned the next
available UID at image-build time rather than a fixed number — this
chart has no reliable way to know that UID in advance without
introspecting your specific built image. Instead of guessing a
`runAsUser`, the pod sets `securityContext.fsGroup` (default `1000`,
`podSecurityContext.fsGroup` in `values.yaml`). Kubernetes adds that GID
as a supplementary group to every container in the pod regardless of
its primary UID, and recursively fixes up the PVC's group ownership and
permissions on mount — which is what actually makes `/home/sorokeep/.sorokeep`
writable by the `sorokeep` user without needing to know its UID.

## Health probes (temporary, process-based)

Repository inspection (see the issue's inspection phase) confirmed:

* **`/healthz` does not exist anywhere in the application.**
* **`/readyz` exists** (`src/observability/server.ts`) but is opt-in
  (only started when `--metrics-port` is passed — this chart does not
  pass it) and binds to `127.0.0.1` only, which an `httpGet` Kubernetes
  probe (executed by the kubelet against the pod IP, outside the
  container's own network namespace) cannot reach.

Given that, `templates/deployment.yaml` uses **`exec` probes** for both
liveness and readiness instead of `httpGet`:

```yaml
exec:
  command: ["sh", "-c", 'grep -qa "dist/index.js" /proc/1/cmdline']
```

The Dockerfile's `ENTRYPOINT` (`["node", "/app/dist/index.js"]`) has no
shell wrapper, so the `node` process running the daemon is always PID 1
inside the container — checking `/proc/1/cmdline` confirms that process
is still alive and is still the daemon, without assuming tools like
`pgrep`/`ps` are installed in the (unverified, not-yet-built) production
image.

**This is explicitly a stand-in, not a real readiness check** — it
confirms the process hasn't died, not that the daemon can actually reach
the database or the configured Stellar RPC endpoint the way `/readyz`'s
existing DB+RPC checks do.

### Follow-up: real HTTP probes

A real fix belongs in the application, not this chart, and is out of
this issue's scope (`src/` is off-limits here):

1. Add a `/healthz` liveness endpoint to `src/observability/server.ts`.
2. Make that server's bind address configurable (or default to
   `0.0.0.0`) so `httpGet` probes from the kubelet can actually reach
   `/healthz`/`/readyz`.

Once both land, `templates/deployment.yaml`'s probes should switch to
`httpGet` against `/healthz` (liveness) and `/readyz` (readiness) on
whatever port `--metrics-port` is set to, and this chart would need a
`metrics.port`/`metrics.enabled` value plus passing `--metrics-port` in
the container's `args` (neither of which this minimal chart adds yet,
since there's no reachable endpoint to point them at today).

## Local kind/minikube testing

A scripted smoke test lives at `tests/smoke/kind-smoke-test.sh` and does
the following against a local `kind` cluster: creates the cluster if
needed, `helm install`s the chart, waits for the pod to become `Ready`,
checks the PVC is `Bound`, and execs into the pod to confirm the daemon
process is running.

```bash
# Build and push (or load into kind) an image first — see "Image
# prerequisite" above. To load a locally built image directly into kind
# without pushing anywhere:
docker build -t sorokeep:local .
kind create cluster --name sorokeep-smoke   # if it doesn't already exist
kind load docker-image sorokeep:local --name sorokeep-smoke

RELEASE_NAME=sorokeep-smoke CLUSTER_NAME=sorokeep-smoke \
  helm install sorokeep-smoke devops/helm/sorokeep \
    --set image.repository=sorokeep --set image.tag=local \
    --set image.pullPolicy=Never

bash devops/helm/sorokeep/tests/smoke/kind-smoke-test.sh
```

The non-cluster checks (`helm lint`, `helm template`, and the manifest
assertions covering replicas/strategy/PVC/ConfigMap/Secret/probes/labels)
can be run without any cluster at all:

```bash
bash devops/helm/sorokeep/tests/run-checks.sh
```

minikube works the same way — swap `kind load docker-image` for
`minikube image load sorokeep:local`.
