#!/usr/bin/env bash
# TDD RED-phase check: `helm template` (dry-run render) must succeed.
#
# Expected to FAIL right now: devops/helm/sorokeep has no Chart.yaml yet,
# so there is nothing to render.
set -uo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "== helm template sorokeep-test $CHART_DIR =="
helm template sorokeep-test "$CHART_DIR"
