#!/usr/bin/env bash
# TDD RED-phase check: values.yaml must not ship real secret values as
# defaults. slackToken / feeSponsorSecret / vault.token / smtp.pass /
# telegramBotToken / the metrics bearer token should all be empty (or
# absent) in the chart's own defaults, so the Secret template only gets
# real values from an operator's -f/--set override or an external
# secrets manager at install time — never from what's committed here.
#
# Expected to FAIL right now: devops/helm/sorokeep/values.yaml doesn't
# exist yet.
set -uo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALUES_FILE="$CHART_DIR/values.yaml"

echo "== checking for real secret defaults in $VALUES_FILE =="

if [[ ! -f "$VALUES_FILE" ]]; then
    echo "[FAIL] $VALUES_FILE does not exist yet — chart not implemented"
    exit 1
fi

# Matches a sensitive key followed by a non-empty, non-comment, non-quoted-empty value.
SENSITIVE_KEYS='slackToken|feeSponsorSecret|vaultToken|smtpPass|telegramBotToken|metricsToken'
suspicious=$(grep -nEi "$SENSITIVE_KEYS" "$VALUES_FILE" | grep -Ev ':\s*("")?\s*(#.*)?$' || true)

if [[ -n "$suspicious" ]]; then
    echo "[FAIL] possible non-empty secret default(s) found:"
    echo "$suspicious"
    exit 1
fi

echo "[PASS] no non-empty secret-like defaults found in values.yaml"
