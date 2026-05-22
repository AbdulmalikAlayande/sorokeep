import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock fetch before importing the module under test ────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendSlackAlert } from "../../src/alerts/slack";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TOKEN = "xoxb-test-slack-bot-token";

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
    return {
        type: "threshold_crossed",
        contractId: "CDEF1234ABCD5678",
        contractName: "my-defi-pool",
        network: "mainnet",
        entry: {
            keyXdr: "AAAA1234",
            type: "instance",
            label: "Contract Instance",
        },
        threshold: {
            configuredLedgers: 10_000,
            currentRemainingLedgers: 4_200,
            approximateTimeRemaining: "~6h 25m",
        },
        firedAtLedger: 2_500_000,
        timestamp: "2026-05-21T20:37:08.000Z",
        ...overrides,
    };
}

function makeSlackOkResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function makeSlackErrorResponse(error: string): Response {
    return new Response(JSON.stringify({ ok: false, error }), {
        status: 200, // Slack always returns 200, error is in body
        headers: { "content-type": "application/json" },
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendSlackAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env["SENTINEL_SLACK_TOKEN"] = VALID_TOKEN;
    });

    afterEach(() => {
        delete process.env["SENTINEL_SLACK_TOKEN"];
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    // =========================================================================
    // 1. TOKEN VALIDATION
    // =========================================================================
    describe("Token validation", () => {
        it("throws a clear error when SENTINEL_SLACK_TOKEN is not set", async () => {
            delete process.env["SENTINEL_SLACK_TOKEN"];

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow("SENTINEL_SLACK_TOKEN");
        });

        it("throws when SENTINEL_SLACK_TOKEN is an empty string", async () => {
            process.env["SENTINEL_SLACK_TOKEN"] = "";

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow("SENTINEL_SLACK_TOKEN");
        });

        it("uses the token in the Authorization header", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Authorization"]).toBe(`Bearer ${VALID_TOKEN}`);
        });
    });

    // =========================================================================
    // 2. HTTP REQUEST SHAPE
});