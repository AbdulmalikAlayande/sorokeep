#!/usr/bin/env python3
"""
TDD RED-phase check: it must be rejected or impossible to run more than
one sorokeep replica, because SQLite/WAL is not safe across concurrent
writers.

Attempts to override the replica count via common Helm value-key
conventions and asserts that either:
  (a) rendering fails outright (the chart rejects the override), or
  (b) rendering succeeds but the effective replica count is still 1
      (the chart doesn't expose replicas as configurable at all).

Expected to FAIL right now: there is no chart to render, so this can't
even be evaluated yet.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from helm_render import render  # noqa: E402

OVERRIDE_ATTEMPTS = [
    ["--set", "replicaCount=3"],
    ["--set", "replicas=3"],
]


def find(docs, kind):
    return [d for d in docs if isinstance(d, dict) and d.get("kind") == kind]


def main() -> int:
    baseline = render()
    if not baseline.ok:
        print(
            "[FAIL] multi-replica enforcement check — cannot evaluate: "
            f"baseline `helm template` failed (exit={baseline.returncode}).\n"
            "       Expected right now: devops/helm/sorokeep has no Chart.yaml yet.\n"
            f"       stderr: {baseline.stderr.strip()}"
        )
        return 1

    failures = []
    for extra_args in OVERRIDE_ATTEMPTS:
        result = render(extra_args=extra_args)
        label = " ".join(extra_args)

        if result.returncode != 0:
            print(f"[PASS] `helm template {label}` was rejected (exit={result.returncode}) — override refused")
            continue

        if result.docs is None:
            failures.append(f"`helm template {label}` exited 0 but produced no parsable manifests")
            continue

        workloads = find(result.docs, "Deployment") + find(result.docs, "StatefulSet")
        if not workloads:
            failures.append(f"`helm template {label}` produced no Deployment/StatefulSet to check replicas on")
            continue

        bad = [w for w in workloads if w.get("spec", {}).get("replicas") != 1]
        if bad:
            names = ", ".join(w["metadata"]["name"] for w in bad)
            failures.append(f"`helm template {label}` produced replicas != 1 for: {names}")
        else:
            print(f"[PASS] `helm template {label}` succeeded but effective replicas stayed at 1")

    if failures:
        print("\n[FAIL] multi-replica override was not rejected or clamped:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nAll override attempts were safely rejected or clamped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
