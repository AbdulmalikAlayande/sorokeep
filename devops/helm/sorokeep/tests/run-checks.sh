#!/usr/bin/env bash
# Runs every non-cluster TDD check for the sorokeep Helm chart in order
# and prints a summary. This is the RED-phase harness: right now every
# check is expected to fail because devops/helm/sorokeep has no chart
# implementation yet (no Chart.yaml, values.yaml, or templates/).
#
# The kind smoke test (tests/smoke/kind-smoke-test.sh) is intentionally
# NOT included here — it needs a real cluster and a working container
# runtime, which isn't guaranteed to be available in every environment.
# Run it separately once the chart exists.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKS_DIR="$HERE/checks"

names=()
statuses=()

for script in "$CHECKS_DIR"/*; do
    name="$(basename "$script")"
    echo
    echo "############################################################"
    echo "# $name"
    echo "############################################################"
    if [[ "$script" == *.py ]]; then
        python3 "$script"
    else
        bash "$script"
    fi
    status=$?
    names+=("$name")
    statuses+=("$status")
done

echo
echo "############################################################"
echo "# SUMMARY"
echo "############################################################"
failed=0
for i in "${!names[@]}"; do
    if [[ "${statuses[$i]}" -eq 0 ]]; then
        echo "[PASS] ${names[$i]}"
    else
        echo "[FAIL] ${names[$i]}"
        failed=$((failed + 1))
    fi
done

echo
echo "$failed / ${#names[@]} check scripts failed."

[[ "$failed" -gt 0 ]] && exit 1
exit 0
