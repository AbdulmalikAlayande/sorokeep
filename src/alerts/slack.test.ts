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
        severity: "warning",
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
        process.env["SOROKEEP_SLACK_TOKEN"] = VALID_TOKEN;
    });

    afterEach(() => {
        delete process.env["SOROKEEP_SLACK_TOKEN"];
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    // =========================================================================
    // 1. TOKEN VALIDATION
    // =========================================================================
    describe("Token validation", () => {
        it("throws a clear error when no Slack token is configured", async () => {
            delete process.env["SOROKEEP_SLACK_TOKEN"];

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow(/[Ss]lack token/);
        });

        it("throws when SOROKEEP_SLACK_TOKEN is an empty string and no config token", async () => {
            process.env["SOROKEEP_SLACK_TOKEN"] = "";

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow(/[Ss]lack token/);
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
    // =========================================================================
    describe("HTTP request shape", () => {
        it("calls the Slack chat.postMessage endpoint", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [url] = mockFetch.mock.calls[0]!;
            expect(url).toContain("chat.postMessage");
        });

        it("uses HTTP POST", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.method).toBe("POST");
        });

        it("sets Content-Type to application/json", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Content-Type"]).toBe("application/json");
        });

        it("sends the correct channel in the body", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#my-alerts", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.channel).toBe("#my-alerts");
        });
    });

    // =========================================================================
    // 3. MESSAGE CONTENT
    // =========================================================================
    describe("Message content", () => {
        it("includes the contract name in the message text", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ contractName: "defi-pool-v2" });

            await sendSlackAlert("#oncall", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const text = body.text ?? JSON.stringify(body.blocks);
            expect(text).toContain("defi-pool-v2");
        });

        it("includes the remaining TTL in the message", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({
                threshold: {
                    configuredLedgers: 10_000,
                    currentRemainingLedgers: 4_200,
                    approximateTimeRemaining: "~6h 25m",
                },
            });

            await sendSlackAlert("#oncall", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const text = body.text ?? JSON.stringify(body.blocks);
            expect(text).toMatch(/4.?200|4200/); // either 4,200 or 4200
        });

        it("includes the network name in the message", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ network: "mainnet" });

            await sendSlackAlert("#oncall", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const text = body.text ?? JSON.stringify(body.blocks);
            expect(text).toContain("mainnet");
        });

        it("uses a warning emoji / indicator for threshold_crossed events", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ type: "threshold_crossed" });

            await sendSlackAlert("#oncall", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const text = body.text ?? JSON.stringify(body.blocks);
            // Should contain a warning indicator — emoji or text
            expect(text.toLowerCase()).toMatch(/warning|⚠|alert|critical|ttl/i);
        });

        it("uses a resolved indicator for alert_resolved events", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ type: "alert_resolved" });

            await sendSlackAlert("#oncall", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const text = body.text ?? JSON.stringify(body.blocks);
            expect(text.toLowerCase()).toMatch(/resolved|recovered|✅|ok/i);
        });

        it("falls back gracefully when contractName is null", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ contractName: null });

            await expect(
                sendSlackAlert("#oncall", event),
            ).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // 4. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws when Slack API returns ok: false", async () => {
            mockFetch.mockResolvedValue(makeSlackErrorResponse("channel_not_found"));

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow("channel_not_found");
        });

        it("throws when Slack API returns ok: false with invalid_auth", async () => {
            mockFetch.mockResolvedValue(makeSlackErrorResponse("invalid_auth"));

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow("invalid_auth");
        });

        it("throws when fetch itself rejects (network error)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toThrow("ECONNREFUSED");
        });

        it("throws on HTTP 500 from Slack", async () => {
            mockFetch.mockResolvedValue(
                new Response("Internal Server Error", { status: 500 }),
            );

            await expect(
                sendSlackAlert("#oncall", makeAlertEvent()),
            ).rejects.toBeDefined();
        });
    });

    // =========================================================================
    // 5. BODY STRUCTURE
    // =========================================================================
    describe("Body structure", () => {
        it("includes a blocks array in the body", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(Array.isArray(body.blocks)).toBe(true);
            expect(body.blocks.length).toBeGreaterThan(0);
        });

        it("includes a fallback text field", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());

            await sendSlackAlert("#oncall", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(typeof body.text).toBe("string");
            expect(body.text.length).toBeGreaterThan(0);
        });
    });
});
