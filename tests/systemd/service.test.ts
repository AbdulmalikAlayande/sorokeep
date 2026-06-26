/**
 * TDD tests for the sorokeep-daemon.service systemd unit file
 * and install-service.sh script.
 *
 * Acceptance criteria:
 *   1. Service file loads cleanly (required sections / directives present).
 *   2. Daemon starts and stops successfully (ExecStart, KillMode, Restart).
 *   3. Logging output maps to journald (StandardOutput=journal).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const serviceContent = () =>
  readFileSync(join(ROOT, "systemd/sorokeep-daemon.service"), "utf8");

const installContent = () =>
  readFileSync(join(ROOT, "systemd/install-service.sh"), "utf8");

// ── [Unit] section ────────────────────────────────────────────────────────────

describe("sorokeep-daemon.service — [Unit]", () => {
  it("contains a [Unit] section", () => {
    expect(serviceContent()).toContain("[Unit]");
  });

  it("has a Description directive", () => {
    expect(serviceContent()).toMatch(/^Description=.+/m);
  });

  it("declares After=network.target", () => {
    expect(serviceContent()).toContain("After=network.target");
  });
});

// ── [Service] section ─────────────────────────────────────────────────────────

describe("sorokeep-daemon.service — [Service]", () => {
  it("contains a [Service] section", () => {
    expect(serviceContent()).toContain("[Service]");
  });

  it("sets Type=simple", () => {
    expect(serviceContent()).toContain("Type=simple");
  });

  it("has an ExecStart directive that invokes sorokeep daemon", () => {
    expect(serviceContent()).toMatch(/^ExecStart=.*sorokeep daemon/m);
  });

  it("has Restart=on-failure for auto-restart", () => {
    expect(serviceContent()).toContain("Restart=on-failure");
  });

  it("has a RestartSec directive", () => {
    expect(serviceContent()).toMatch(/^RestartSec=\d+/m);
  });

  it("maps stdout to journald via StandardOutput=journal", () => {
    expect(serviceContent()).toContain("StandardOutput=journal");
  });

  it("maps stderr to journald via StandardError=journal", () => {
    expect(serviceContent()).toContain("StandardError=journal");
  });

  it("sets SyslogIdentifier for journal filtering", () => {
    expect(serviceContent()).toContain("SyslogIdentifier=sorokeep");
  });

  it("uses KillMode=mixed for clean shutdown", () => {
    expect(serviceContent()).toContain("KillMode=mixed");
  });
});

// ── [Install] section ─────────────────────────────────────────────────────────

describe("sorokeep-daemon.service — [Install]", () => {
  it("contains an [Install] section", () => {
    expect(serviceContent()).toContain("[Install]");
  });

  it("targets multi-user.target", () => {
    expect(serviceContent()).toContain("WantedBy=multi-user.target");
  });
});

// ── install-service.sh ────────────────────────────────────────────────────────

describe("install-service.sh", () => {
  it("copies the service file to /etc/systemd/system/", () => {
    expect(installContent()).toContain("/etc/systemd/system/sorokeep-daemon.service");
  });

  it("runs systemctl daemon-reload", () => {
    expect(installContent()).toContain("systemctl daemon-reload");
  });

  it("enables the service on boot", () => {
    expect(installContent()).toContain("systemctl enable sorokeep-daemon");
  });

  it("starts the service", () => {
    expect(installContent()).toContain("systemctl start sorokeep-daemon");
  });
});
