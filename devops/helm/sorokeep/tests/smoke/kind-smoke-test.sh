#!/usr/bin/env bash
# TDD RED-phase / acceptance check: `helm install` on a local kind
# cluster must produce a running pod that starts the sorokeep daemon,
# with the PVC bound and mounted.
#
# NOT run automatically by run-checks.sh — it needs a real cluster and a
# container runtime (docker or podman) that kind can use as its node
# provider, which isn't guaranteed to be available in every environment.
#
# Expected to FAIL right now for up to two independent reasons:
#   1. devops/helm/sorokeep has no Chart.yaml yet — `helm install` has
#      nothing to install. This is the chart-side RED evidence.
#   2. This may ALSO fail (or refuse to run) in environments without a
#      working container runtime for kind to use — that failure is
#      environment-specific, not chart-specific, and is reported as a
#      distinct preflight failure below rather than conflated with (1).
set -uo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sorokeep-smoke}"
RELEASE_NAME="${RELEASE_NAME:-sorokeep-smoke}"
NAMESPACE="${NAMESPACE:-default}"
CREATED_CLUSTER=0

fail() {
    echo "[FAIL] $1" >&2
    exit 1
}

echo "== preflight =="
command -v kind >/dev/null 2>&1 || fail "kind is not installed"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is not installed"
command -v helm >/dev/null 2>&1 || fail "helm is not installed"

if ! (command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1); then
    fail "no working container runtime (docker/podman) found — kind cannot create a cluster here"
fi

if [[ ! -f "$CHART_DIR/Chart.yaml" ]]; then
    fail "$CHART_DIR/Chart.yaml does not exist yet — chart not implemented"
fi

cleanup() {
    echo "== cleanup =="
    helm uninstall "$RELEASE_NAME" -n "$NAMESPACE" >/dev/null 2>&1 || true
    if [[ "$CREATED_CLUSTER" -eq 1 ]]; then
        kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

echo "== ensuring kind cluster '$CLUSTER_NAME' exists =="
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    kind create cluster --name "$CLUSTER_NAME" || fail "kind create cluster failed"
    CREATED_CLUSTER=1
fi

kubectl config use-context "kind-$CLUSTER_NAME" || fail "could not switch kubectl context"

echo "== helm install =="
helm install "$RELEASE_NAME" "$CHART_DIR" -n "$NAMESPACE" --create-namespace \
    || fail "helm install failed"

echo "== waiting for pod to be Ready =="
kubectl wait --for=condition=Ready pod \
    -l "app.kubernetes.io/instance=$RELEASE_NAME" \
    -n "$NAMESPACE" --timeout=180s \
    || fail "pod did not become Ready within 180s"

POD_NAME=$(kubectl get pod -n "$NAMESPACE" \
    -l "app.kubernetes.io/instance=$RELEASE_NAME" \
    -o jsonpath='{.items[0].metadata.name}')

echo "== checking PVC is Bound =="
PVC_STATUS=$(kubectl get pvc -n "$NAMESPACE" \
    -l "app.kubernetes.io/instance=$RELEASE_NAME" \
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
[[ "$PVC_STATUS" == "Bound" ]] || fail "PVC is not Bound (status='$PVC_STATUS')"

echo "== checking the daemon process is running in $POD_NAME =="
kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
    pgrep -f "dist/index.js" >/dev/null \
    || fail "no dist/index.js process found in $POD_NAME"

echo "[PASS] kind smoke test: pod Ready, PVC Bound, daemon process running"
