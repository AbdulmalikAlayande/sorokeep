#!/usr/bin/env bash
# TDD RED-phase check: `helm lint` must pass against the chart.
#
# Expected to FAIL right now: devops/helm/sorokeep has no Chart.yaml yet,
# so helm has nothing to lint.
set -uo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "== helm lint $CHART_DIR =="
helm lint "$CHART_DIR"
