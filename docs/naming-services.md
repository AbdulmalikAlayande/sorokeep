# Naming Services Integration

Contract IDs are unreadable 56-character strings (e.g. `CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6`). Teams using a Soroban naming service to give contracts human-readable names can wire that name straight into sorokeep so it shows up everywhere sorokeep already displays a contract — alert payloads, `sorokeep status`, `sorokeep contracts`, and `sorokeep fleet status` all read from the same `contractName` field.

## The pattern

sorokeep has no built-in naming-service integration and doesn't need one: `sorokeep watch` already accepts a `--name` flag, and every alert/status code path prefers that name over the raw contract ID when one is set. The integration is one step:

1. Resolve a human-readable name to a contract ID using whatever naming service your team uses.
2. Pass the resolved ID and the original name to `sorokeep watch`:

```bash
sorokeep watch <contract-id> --name <resolved-name>
```

That's it — no plugin, no config file. Re-running `watch` with a new `--name` on an already-registered contract updates the display name in place.

## Example: hypothetical resolution script

No Soroban naming service has reached broad, stable production adoption as of this writing, so the script below is **hypothetical** — it shows the shape of the integration assuming a naming service exposes a simple HTTP resolution endpoint. Swap the `resolve()` function for whatever your actual naming service's SDK or API provides.

```bash
#!/usr/bin/env bash
# resolve-and-watch.sh — hypothetical naming-service integration.
# Replace the curl call below with your naming service's actual resolution API.
set -euo pipefail

NAME="$1"
RESOLVER_URL="https://example-naming-service.invalid/resolve"

CONTRACT_ID=$(curl -sf "${RESOLVER_URL}?name=${NAME}" | jq -r '.contractId')

if [ -z "$CONTRACT_ID" ] || [ "$CONTRACT_ID" = "null" ]; then
  echo "Could not resolve name '${NAME}' to a contract ID" >&2
  exit 1
fi

sorokeep watch "$CONTRACT_ID" --name "$NAME"
```

Usage: `./resolve-and-watch.sh my-contract`

## If you're using a real naming service today

If a specific naming service becomes the de facto standard for Soroban, update this doc with a concrete, tested example against its real API rather than the hypothetical script above — see [CONTRIBUTING.md](../CONTRIBUTING.md) for how to submit doc updates.
