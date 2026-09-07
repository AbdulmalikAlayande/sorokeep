"""Shared helper for chart-rendering test checks.

Centralizes the `helm template` invocation and YAML parsing so every
assertion script under tests/checks/ renders the chart the same way and
doesn't re-implement subprocess/YAML-parsing plumbing.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

import yaml

# tests/lib/helm_render.py -> tests/lib -> tests -> devops/helm/sorokeep
CHART_DIR = Path(__file__).resolve().parents[2]
DEFAULT_RELEASE = "sorokeep-test"


class RenderResult:
    def __init__(self, returncode: int, stdout: str, stderr: str, docs: Optional[list]):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.docs = docs  # None if rendering failed or output didn't parse as YAML

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and self.docs is not None


def render(extra_args: Optional[list] = None, release: str = DEFAULT_RELEASE) -> RenderResult:
    """Run `helm template <release> <chart_dir> [extra_args...]` and parse the result."""
    args = ["helm", "template", release, str(CHART_DIR)]
    if extra_args:
        args.extend(extra_args)

    proc = subprocess.run(args, capture_output=True, text=True)
    docs = None
    if proc.returncode == 0:
        try:
            docs = [d for d in yaml.safe_load_all(proc.stdout) if d]
        except yaml.YAMLError:
            docs = None

    return RenderResult(proc.returncode, proc.stdout, proc.stderr, docs)
