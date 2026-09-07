import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAlertChannels, _resetRegistryForTesting } from "../../src/alerts/registry.js";
import { registerBuiltinChannels, _resetBuiltinRegistrationForTesting } from "../../src/alerts/builtins.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const README_PATH = path.resolve(__dirname, "../../README.md");

// Maps a registry channel name to how it's spelled out in the README table,
// since a couple of channels use a display name that differs from their
// `--type` value (e.g. "teams" -> "Microsoft Teams").
const DISPLAY_NAMES: Record<string, string> = {
    webhook: "Webhook",
    webhook2: "Webhook v2",
    slack: "Slack",
    pagerduty: "PagerDuty",
    opsgenie: "Opsgenie",
    discord: "Discord",
    telegram: "Telegram",
    teams: "Microsoft Teams",
    matrix: "Matrix",
    email: "Email",
    googlechat: "Google Chat",
    sns: "AWS SNS",
};

describe("README channel comparison table", () => {
    beforeEach(() => {
        _resetRegistryForTesting();
        _resetBuiltinRegistrationForTesting();
        registerBuiltinChannels();
    });

    it("lists every channel currently registered in builtins.ts", () => {
        const readme = fs.readFileSync(README_PATH, "utf-8");
        const registeredNames = listAlertChannels().map((d) => d.name);

        for (const name of registeredNames) {
            const displayName = DISPLAY_NAMES[name];
            expect(displayName, `no README display-name mapping for registered channel "${name}"`).toBeDefined();
            expect(readme, `README comparison table is missing "${displayName}" (registry name "${name}")`).toContain(displayName!);
        }
    });

    it("has exactly one table row per registered channel (no stale or missing rows)", () => {
        const readme = fs.readFileSync(README_PATH, "utf-8");
        const tableSection = readme.split("### Supported Channels Comparison")[1]?.split("### Alert Lifecycle")[0] ?? "";

        // Table rows look like "| **Webhook** | ... |" — count non-header,
        // non-separator rows starting with "| **".
        const rowCount = tableSection.split("\n").filter((line) => line.trim().startsWith("| **")).length;

        expect(rowCount).toBe(listAlertChannels().length);
    });
});
