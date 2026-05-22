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
});