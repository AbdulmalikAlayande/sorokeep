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
});