# Guard Policy Export/Import

## Overview

The `sorokeep guard export` and `sorokeep guard import` commands allow you to back up, move, or share extension policy configurations between contracts and machines.

## Security

**CRITICAL**: Per `SECURITY.md`, exported policies **never contain raw secret keys**. Only public keys and `env:` or `vault:` references are exported. This ensures:

1. Policies can be safely committed to version control
2. Team members can share configurations without exposing secrets
3. Backup files don't leak sensitive key material

## Usage

### Export a Policy

Export to stdout:
```bash
sorokeep guard export <CONTRACT_ID>
```

Export to file:
```bash
sorokeep guard export <CONTRACT_ID> --out policy.json
```

### Import a Policy

Import from file:
```bash
sorokeep guard import <CONTRACT_ID> --file policy.json
```

Import from stdin:
```bash
cat policy.json | sorokeep guard import <CONTRACT_ID>
```

## Export Format

Exported policies are JSON with the following structure:

```json
{
  "contract_id": "CDLZFC3...",
  "enabled": true,
  "target_ttl_ledgers": 100000,
  "extend_when_below_ledgers": 20000,
  "keypair_public": "GA4YORX...",
  "keypair_source": "env:STELLAR_KEY"
}
```

### Fields

- **contract_id**: Original contract ID (ignored on import)
- **enabled**: Whether auto-extension is active
- **target_ttl_ledgers**: Target TTL after extension
- **extend_when_below_ledgers**: Threshold for triggering extensions
- **keypair_public**: Stellar public key (G...) or null
- **keypair_source**: Key reference (`env:VAR_NAME` or `vault:path`) or null

## Validation

Import validates:

1. ✅ Required fields present
2. ✅ Numeric constraints (positive, threshold < target)
3. ✅ Public key format (G prefix, 56 chars)
4. ✅ keypair_source is `env:` or `vault:` reference (not raw secret)
5. ✅ Both keypair fields present or both null
6. ✅ No forbidden secret key fields (`keypair_secret`, `private_key`, etc.)

## Use Cases

### Backup
```bash
# Backup all contract policies
for contract in $(sorokeep list --json | jq -r '.[].id'); do
  sorokeep guard export "$contract" --out "backup-${contract}.json"
done
```

### Team Sharing
```bash
# Developer A exports their tested configuration
sorokeep guard export CDLZFC3... --out production-policy.json
git add production-policy.json && git commit -m "Add production guard policy"

# Developer B imports it on their machine
git pull
sorokeep guard import CDLZFC3... --file production-policy.json
```

### Contract Migration
```bash
# Copy policy from old contract to new contract
sorokeep guard export OLD_CONTRACT_ID --out policy.json
sorokeep guard import NEW_CONTRACT_ID --file policy.json
```

### Environment Promotion
```bash
# Export testnet policy
sorokeep guard export TESTNET_CONTRACT --out testnet-policy.json

# Modify for mainnet (if needed)
jq '.keypair_source = "vault:mainnet/stellar/key"' testnet-policy.json > mainnet-policy.json

# Import to mainnet contract
sorokeep guard import MAINNET_CONTRACT --file mainnet-policy.json
```

## Implementation Notes

- Export/import functions are in `src/commands/guard.ts`
- Core logic uses existing `getExtensionPolicy()` and `upsertExtensionPolicy()` from repositories
- Comprehensive tests in `tests/commands/guard-export-import.test.ts` and `tests/commands/guard-cli-export-import.test.ts`
- Security validations prevent any raw secret key from being exported or imported

## Related Commands

- `sorokeep guard <CONTRACT_ID>` - View current policy
- `sorokeep guard <CONTRACT_ID> --auto-extend --keypair-env VAR` - Configure auto-extension
- `sorokeep guard <CONTRACT_ID> --disable` - Disable auto-extension
