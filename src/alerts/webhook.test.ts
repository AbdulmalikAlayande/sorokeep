import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ─── Mock fetch before importing the module under test ────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendWebhookAlert } from "../../src/alerts/webhook";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
    return {
        type: "threshold_crossed",
        severity: "warning",
        contractId: "CDEF1234ABCD5678",
        contractName: "my-defi-pool",
        network: "testnet",
        entry: {
            keyXdr: "AAAA1234",
            type: "instance",
            label: "Contract Instance",
        },
        threshold: {
            configuredLedgers: 20_000,
            currentRemainingLedgers: 8_500,
            approximateTimeRemaining: "~13h 0m",
        },
        firedAtLedger: 2_500_000,
        timestamp: "2026-05-21T20:37:08.000Z",
        ...overrides,
    };
}

function makeOkResponse(status = 200): Response {
    if (status === 204) {
        return new Response(null, { status });
    }
    return new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function makeErrorResponse(status: number, body = "Bad Request"): Response {
    return new Response(body, { status });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendWebhookAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    // =========================================================================
    // 1. HTTP REQUEST SHAPE
    // =========================================================================
    describe("HTTP request shape", () => {
        it("calls fetch with the correct URL", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const url = "https://ops.example.com/webhook";

            await sendWebhookAlert(url, makeAlertEvent());

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [calledUrl] = mockFetch.mock.calls[0]!;
            expect(calledUrl).toBe(url);
        });

        it("uses HTTP POST method", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.method).toBe("POST");
        });

        it("sets Content-Type to application/json", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Content-Type"]).toBe("application/json");
        });

        it("sends the full AlertEvent as the JSON body", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ contractId: "UNIQUE_CONTRACT_ID" });

            await sendWebhookAlert("https://example.com/hook", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.type).toBe("threshold_crossed");
            expect(body.contractId).toBe("UNIQUE_CONTRACT_ID");
            expect(body.contractName).toBe("my-defi-pool");
            expect(body.network).toBe("testnet");
            expect(body.entry.type).toBe("instance");
            expect(body.threshold.configuredLedgers).toBe(20_000);
            expect(body.firedAtLedger).toBe(2_500_000);
        });

        it("sends alert_resolved events with type = 'alert_resolved'", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ type: "alert_resolved" });

            await sendWebhookAlert("https://example.com/hook", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.type).toBe("alert_resolved");
        });
    });

    // =========================================================================
    // 2. HMAC SIGNING
    // =========================================================================
    describe("HMAC signing", () => {
        it("does not include X-Sorokeep-Signature header when no secret provided", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["X-Sorokeep-Signature"]).toBeUndefined();
        });

        it("includes X-Sorokeep-Signature header when secret is provided", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const secret = "my-webhook-secret";

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent(), secret);

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["X-Sorokeep-Signature"]).toBeDefined();
            expect(options.headers["X-Sorokeep-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
        });

        it("signature is a valid HMAC-SHA256 of the body", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const secret = "test-secret-key";
            const event = makeAlertEvent();

            await sendWebhookAlert("https://example.com/hook", event, secret);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = options.body as string;
            const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
            expect(options.headers["X-Sorokeep-Signature"]).toBe(`sha256=${expectedSig}`);
        });

        it("does not include signature when secret is null", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent(), null);

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["X-Sorokeep-Signature"]).toBeUndefined();
        });
    });

    // =========================================================================
    // 3. SUCCESS HANDLING
    // =========================================================================
    describe("Success handling", () => {
        it("resolves without throwing on 200", async () => {
            mockFetch.mockResolvedValue(makeOkResponse(200));
            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).resolves.not.toThrow();
        });

        it("resolves without throwing on 201", async () => {
            mockFetch.mockResolvedValue(makeOkResponse(201));
            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).resolves.not.toThrow();
        });

        it("resolves without throwing on 204", async () => {
            mockFetch.mockResolvedValue(makeOkResponse(204));
            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // 4. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws on 400 Bad Request", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(400));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("400");
        });

        it("throws on 500 Internal Server Error", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(500));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("500");
        });

        it("throws when fetch itself rejects (network unreachable)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("ECONNREFUSED");
        });
    });

    // =========================================================================
    // 5. REQUEST CONFIGURATION
    // =========================================================================
    describe("Request configuration", () => {
        it("sets a signal for abort / timeout control", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.signal).toBeDefined();
        });

        it("body includes severity field", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent();

            await sendWebhookAlert("https://example.com/hook", event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const keys = Object.keys(body).sort();
            expect(keys).toEqual([
                "contractId",
                "contractName",
                "entry",
                "firedAtLedger",
                "network",
                "severity",
                "threshold",
                "timestamp",
                "type",
            ]);
        });
    });
});
