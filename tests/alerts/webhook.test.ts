import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock fetch before importing the module under test ────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendWebhookAlert } from "../../src/alerts/webhook";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
    return {
        type: "threshold_crossed",
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
    // 204 No Content must not have a body (Response constructor enforces this)
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
    // 2. SUCCESS HANDLING
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
    // 3. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws on 400 Bad Request", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(400));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("400");
        });

        it("throws on 401 Unauthorized", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(401));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("401");
        });

        it("throws on 404 Not Found", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(404));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("404");
        });

        it("throws on 500 Internal Server Error", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(500));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("500");
        });

        it("throws on 503 Service Unavailable", async () => {
            mockFetch.mockResolvedValue(makeErrorResponse(503));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("503");
        });

        it("throws when fetch itself rejects (network unreachable)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toThrow("ECONNREFUSED");
        });

        it("throws when fetch rejects with a non-Error value", async () => {
            mockFetch.mockRejectedValue("network gone");

            await expect(
                sendWebhookAlert("https://example.com/hook", makeAlertEvent()),
            ).rejects.toBeDefined();
        });
    });

    // =========================================================================
    // 4. REQUEST CONFIGURATION
    // =========================================================================
    describe("Request configuration", () => {
        it("sets a signal for abort / timeout control", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendWebhookAlert("https://example.com/hook", makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            // signal must be an AbortSignal instance
            expect(options.signal).toBeDefined();
        });

        it("does not send extra unexpected top-level keys in the body", async () => {
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
                "threshold",
                "timestamp",
                "type",
            ]);
        });
    });
});
