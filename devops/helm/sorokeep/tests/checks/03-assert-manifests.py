#!/usr/bin/env python3
"""
TDD RED-phase checks for the (not yet implemented) sorokeep Helm chart.

Covers the acceptance-criteria items that require an actual rendered
manifest to inspect:
  - exactly one replica
  - Recreate / single-instance-safe update strategy
  - a PersistentVolumeClaim exists (ReadWriteOnce)
  - the PVC is mounted at /home/sorokeep/.sorokeep
  - a ConfigMap exists and holds only non-sensitive keys
  - a Secret exists, is a distinct object from the ConfigMap, and holds
    the sensitive keys
  - no real secret values ship in the rendered defaults
  - probes are exec/process-based, not httpGet
  - no probe references /healthz or /readyz
  - labels/selectors are internally consistent

Every check here is expected to FAIL right now: devops/helm/sorokeep has
no Chart.yaml yet, so `helm template` cannot produce any manifests for
these checks to inspect. That failure is the RED evidence for this phase.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from helm_render import render  # noqa: E402

SENSITIVE_KEYS = {
    "slackToken", "feeSponsorSecret", "vaultToken", "vault.token",
    "smtpPass", "smtp.pass", "telegramBotToken", "metricsToken",
    "SOROKEEP_METRICS_TOKEN",
}
DB_MOUNT_PATH = "/home/sorokeep/.sorokeep"
FORBIDDEN_PROBE_PATHS = {"/healthz", "/readyz"}


def find(docs, kind):
    return [d for d in docs if isinstance(d, dict) and d.get("kind") == kind]


def check_replica_count(docs):
    workloads = find(docs, "Deployment") + find(docs, "StatefulSet")
    if not workloads:
        return False, "no Deployment/StatefulSet rendered"
    for w in workloads:
        replicas = w.get("spec", {}).get("replicas")
        if replicas != 1:
            return False, f"{w['metadata']['name']}: replicas={replicas!r}, expected 1"
    return True, f"{len(workloads)} workload(s), all replicas=1"


def check_strategy(docs):
    deployments = find(docs, "Deployment")
    for d in deployments:
        strategy_type = d.get("spec", {}).get("strategy", {}).get("type")
        if strategy_type != "Recreate":
            return False, f"{d['metadata']['name']}: strategy.type={strategy_type!r}, expected 'Recreate'"
    if deployments:
        return True, f"{len(deployments)} Deployment(s) use Recreate"
    if find(docs, "StatefulSet"):
        return True, "StatefulSet in use (ordinal-ordered updates are single-instance-safe by construction)"
    return False, "no Deployment or StatefulSet rendered"


def check_pvc_exists(docs):
    pvcs = find(docs, "PersistentVolumeClaim")
    templated_pvcs = []
    for w in find(docs, "StatefulSet"):
        templated_pvcs.extend(w.get("spec", {}).get("volumeClaimTemplates", []) or [])
    if not pvcs and not templated_pvcs:
        return False, "no PersistentVolumeClaim (standalone or via volumeClaimTemplates) rendered"
    access_modes = []
    for p in pvcs + templated_pvcs:
        access_modes.extend(p.get("spec", {}).get("accessModes", []) or [])
    bad_modes = [m for m in access_modes if m != "ReadWriteOnce"]
    if bad_modes:
        return False, f"PVC access modes {access_modes} include something other than ReadWriteOnce"
    return True, f"{len(pvcs) + len(templated_pvcs)} PVC(s), all ReadWriteOnce"


def check_pvc_mount_path(docs):
    workloads = find(docs, "Deployment") + find(docs, "StatefulSet")
    for w in workloads:
        containers = w.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []) or []
        for c in containers:
            for vm in c.get("volumeMounts", []) or []:
                if vm.get("mountPath") == DB_MOUNT_PATH:
                    return True, f"container {c.get('name')} mounts {DB_MOUNT_PATH}"
    return False, f"no container volumeMount targets {DB_MOUNT_PATH}"


def check_configmap(docs):
    cms = find(docs, "ConfigMap")
    if not cms:
        return False, "no ConfigMap rendered"
    for cm in cms:
        data = {**(cm.get("data") or {}), **(cm.get("binaryData") or {})}
        leaked_keys = [k for k in data if k in SENSITIVE_KEYS]
        blob = " ".join(str(v) for v in data.values())
        leaked_in_blob = [k for k in SENSITIVE_KEYS if k in blob]
        if leaked_keys or leaked_in_blob:
            return False, (
                f"ConfigMap {cm['metadata']['name']} appears to contain "
                f"sensitive key(s): {leaked_keys or leaked_in_blob}"
            )
    return True, f"{len(cms)} ConfigMap(s), no sensitive keys found"


def check_secret(docs):
    secrets = find(docs, "Secret")
    cms = find(docs, "ConfigMap")
    if not secrets:
        return False, "no Secret rendered"
    cm_names = {cm["metadata"]["name"] for cm in cms}
    for s in secrets:
        if s["metadata"]["name"] in cm_names:
            return False, f"Secret {s['metadata']['name']} shares a name with a ConfigMap — not a separate object"
    return True, f"{len(secrets)} Secret(s), distinct from {len(cms)} ConfigMap(s)"


def check_no_real_secret_values(docs):
    secrets = find(docs, "Secret")
    if not secrets:
        return False, "no Secret rendered to check"
    placeholder_markers = {"", "changeme", "CHANGE_ME", "REPLACE_ME"}
    for s in secrets:
        data = {**(s.get("data") or {}), **(s.get("stringData") or {})}
        for k, v in data.items():
            if str(v).strip() and str(v).strip() not in placeholder_markers:
                return False, f"Secret {s['metadata']['name']}.{k} has a non-empty default value in the rendered chart"
    return True, "no non-empty default secret values found"


def check_exec_probes(docs):
    workloads = find(docs, "Deployment") + find(docs, "StatefulSet")
    if not workloads:
        return False, "no Deployment/StatefulSet rendered"
    for w in workloads:
        containers = w.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []) or []
        for c in containers:
            for probe_name in ("livenessProbe", "readinessProbe"):
                probe = c.get(probe_name)
                if probe and "httpGet" in probe:
                    return False, (
                        f"container {c.get('name')}.{probe_name} uses httpGet "
                        "(expected exec, since /healthz and /readyz can't be safely probed this way yet)"
                    )
    return True, "no httpGet probes found on the default configuration"


def check_no_forbidden_probe_paths(docs):
    workloads = find(docs, "Deployment") + find(docs, "StatefulSet")
    for w in workloads:
        containers = w.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []) or []
        for c in containers:
            for probe_name in ("livenessProbe", "readinessProbe", "startupProbe"):
                probe = c.get(probe_name) or {}
                path = (probe.get("httpGet") or {}).get("path")
                if path in FORBIDDEN_PROBE_PATHS:
                    return False, f"container {c.get('name')}.{probe_name} targets {path}, which does not exist in the app yet"
    return True, "no probe targets /healthz or /readyz"


def check_label_consistency(docs):
    workloads = find(docs, "Deployment") + find(docs, "StatefulSet")
    services = find(docs, "Service")
    if not workloads:
        return False, "no Deployment/StatefulSet rendered"
    for w in workloads:
        selector = w.get("spec", {}).get("selector", {}).get("matchLabels", {}) or {}
        template_labels = w.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {}) or {}
        if not selector:
            return False, f"{w['metadata']['name']}: spec.selector.matchLabels is empty"
        mismatched = {k: v for k, v in selector.items() if template_labels.get(k) != v}
        if mismatched:
            return False, f"{w['metadata']['name']}: selector {selector} not satisfied by pod template labels {template_labels}"
        for svc in services:
            svc_selector = svc.get("spec", {}).get("selector", {}) or {}
            svc_mismatched = {k: v for k, v in svc_selector.items() if template_labels.get(k) != v}
            if svc_mismatched:
                return False, f"Service {svc['metadata']['name']} selector {svc_selector} does not match workload pod labels {template_labels}"
    return True, "selectors match pod template labels for all workloads/services"


CHECKS = [
    ("exactly one replica configured", check_replica_count),
    ("update strategy is single-instance-safe (Recreate for Deployment)", check_strategy),
    ("a PersistentVolumeClaim exists (ReadWriteOnce)", check_pvc_exists),
    (f"PVC is mounted at {DB_MOUNT_PATH}", check_pvc_mount_path),
    ("ConfigMap exists and holds only non-sensitive keys", check_configmap),
    ("Secret exists, is separate from the ConfigMap, and holds sensitive keys", check_secret),
    ("no real secret values in rendered defaults", check_no_real_secret_values),
    ("probes are exec/process-based, not httpGet", check_exec_probes),
    ("no HTTP probe references /healthz or /readyz", check_no_forbidden_probe_paths),
    ("labels/selectors are internally consistent", check_label_consistency),
]


def main() -> int:
    result = render()
    outcomes = []

    if not result.ok:
        reason = (
            f"`helm template` did not produce usable manifests (exit={result.returncode}). "
            "Expected right now: devops/helm/sorokeep has no Chart.yaml yet.\n"
            f"    stderr: {result.stderr.strip()}"
        )
        for name, _ in CHECKS:
            outcomes.append((name, False, reason))
    else:
        for name, fn in CHECKS:
            try:
                ok, detail = fn(result.docs)
            except Exception as exc:  # a check crashing counts as a failure, not a script crash
                ok, detail = False, f"check raised {type(exc).__name__}: {exc}"
            outcomes.append((name, ok, detail))

    width = max(len(name) for name, _, _ in outcomes)
    failed = sum(1 for _, ok, _ in outcomes if not ok)
    for name, ok, detail in outcomes:
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {name.ljust(width)}  {detail}")

    print(f"\n{len(outcomes) - failed}/{len(outcomes)} checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
