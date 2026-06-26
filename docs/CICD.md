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
