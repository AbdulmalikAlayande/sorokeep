# CI/CD Integration Guide

This guide shows how to run Sorokeep checks in common CI/CD providers. Each example is copy-pasteable — replace repository-specific settings and secrets as needed.

## GitHub Actions

Create a workflow file at `.github/workflows/sorokeep.yml` with the following content:

```yaml
name: Sorokeep checks

on: [push, pull_request]

jobs:
  sorokeep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      - name: Run Sorokeep checks
        run: npx sorokeep
```

Notes:
- Use `npx sorokeep` to invoke the repository-installed CLI. If you build a distribution, replace with your build step.
- The job will fail if `sorokeep` exits with a non-zero status, making it suitable for gating pull requests.

### Pre-deploy TTL extension example

For a mainnet deploy gate, use a one-time TTL extension immediately before the deploy job rather than enabling the daemon's persistent `--auto-extend` policy. See the example workflow at `.github/workflows/examples/predeploy-ttl-extension.yml`.

```yaml
name: Pre-deploy TTL extension

on:
  workflow_dispatch:
    inputs:
      contract-id:
        description: Soroban contract ID to extend before deploy
        required: true

jobs:
  extend-ttl-before-deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      - name: Extend TTLs before deploy
        env:
          STELLAR_SECRET_KEY: ${{ secrets.MAINNET_EXTENSION_KEY }}
        run: |
          npx sorokeep guard "${{ inputs.contract-id }}" \
            --keypair-env STELLAR_SECRET_KEY \
            --target-ttl 100000 \
            --threshold 20000
```

Required secrets and scoping:
- `STELLAR_RPC_URL`: a read-only mainnet RPC URL for the contract/health check you want to validate before deploy.
- `MAINNET_EXTENSION_KEY`: a funded Stellar secret key used only for the one-time extension transaction.
- Prefer using a protected GitHub environment or branch-restricted workflow so the deploy secret cannot be used outside the mainnet release job.
- Do not use `--auto-extend` here; that enables a long-lived daemon policy. This example is intentionally a one-off extension ahead of a ship event.

## GitLab CI

Add the following to `.gitlab-ci.yml`:

```yaml
stages:
  - test

sorokeep_checks:
  image: node:20
  stage: test
  script:
    - npm ci
    - npx sorokeep
  only:
    - branches
    - merge_requests
```

Notes:
- GitLab will mark the pipeline failed if `npx sorokeep` exits non-zero.

## Bitbucket Pipelines

Add the following to `bitbucket-pipelines.yml`:

```yaml
pipelines:
  default:
    - step:
        name: Sorokeep checks
        image: node:20
        script:
          - npm ci
          - npx sorokeep
```

Notes:
- Ensure your repository has `package.json` and dependencies installed in CI so the `sorokeep` binary is available via `npx`.

## Advanced

- If Sorokeep requires environment variables (API keys, network URLs), expose them via your provider's secrets or variables and reference them in the job.
- For faster runs, cache `node_modules` between runs using each provider's cache mechanism.

If you want examples for other CI providers, open an issue or PR and I’ll add them.
