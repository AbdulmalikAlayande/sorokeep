#!/usr/bin/env bash
# Sorokeep TTL check action entrypoint.
# Reads SOROKEEP_* env vars, runs the CLI in JSON mode, and writes outputs.
set -uo pipefail

CONTRACT_ID="${SOROKEEP_CONTRACT_ID}"
NETWORK="${SOROKEEP_NETWORK:-testnet}"
THRESHOLD="${SOROKEEP_THRESHOLD:-500}"
RPC_URL="${SOROKEEP_RPC_URL:-}"
ACTION_PATH="${GITHUB_ACTION_PATH:-.}"

ARGS=("${CONTRACT_ID}" --network "${NETWORK}" --threshold "${THRESHOLD}" --json)
if [ -n "${RPC_URL}" ]; then
    ARGS+=(--rpc-url "${RPC_URL}")
fi

echo "::group::Sorokeep TTL check — contract ${CONTRACT_ID} on ${NETWORK} (threshold: ${THRESHOLD} ledgers)"

# Run check; capture output and exit code without aborting on failure.
set +e
CHECK_JSON=$(node "${ACTION_PATH}/dist/index.js" check "${ARGS[@]}")
CHECK_EXIT=$?
set -e

echo "${CHECK_JSON}"
echo "::endgroup::"

# Parse TTL from JSON output.
TTL=$(node -e "
try {
    const r = JSON.parse(process.argv[1]);
    process.stdout.write(String(r.minimumTTL));
} catch {
    process.stdout.write('0');
}
" -- "${CHECK_JSON}" 2>/dev/null || echo "0")

if [ "${CHECK_EXIT}" -eq 0 ]; then
    STATUS="passed"
    echo "::notice title=Sorokeep TTL Check::Passed — minimumTTL=${TTL} >= threshold=${THRESHOLD} for contract ${CONTRACT_ID}"
else
    STATUS="failed"
    echo "::error title=Sorokeep TTL Check::Failed — minimumTTL=${TTL} < threshold=${THRESHOLD} for contract ${CONTRACT_ID}"
fi

GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
echo "ttl=${TTL}" >> "${GITHUB_OUTPUT_FILE}"
echo "status=${STATUS}" >> "${GITHUB_OUTPUT_FILE}"

exit "${CHECK_EXIT}"
