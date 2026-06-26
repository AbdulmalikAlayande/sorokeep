import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPagerDutyAlert } from "../../src/alerts/pagerduty";
import type { AlertEvent } from "../../src/alerts/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
    return {
        type: "threshold_crossed",
        severity: "critical",
        contractId: "CABC1234",
        contractName: "my-contract",
        network: "testnet",
        entry: {
            keyXdr: "AAAA1",
            type: "instance",
            label: "primary-entry",
        },
        threshold: {
            configuredLedgers: 1000,
            currentRemainingLedgers: 120,
            approximateTimeRemaining: "~2h",
        },
        firedAtLedger: 3_000_000,
        timestamp: "2026-06-24T00:00:00.000Z",
        ...overrides,
    };
}

function makeOkResponse(status = 202): Response {
    return new Response(null, { status });
}

function makeErrorResponse(status = 500): Response {
    return new Response(null, { status });
}

describe("sendPagerDutyAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    it("calls the PagerDuty Events API with the routing key and trigger action", async () => {
        mockFetch.mockResolvedValue(makeOkResponse());
        const event = makeAlertEvent();

        await sendPagerDutyAlert("test-routing-key", event);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0]!;
        expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = JSON.parse(options.body as string);
        expect(body.routing_key).toBe("test-routing-key");
        expect(body.event_action).toBe("trigger");
        expect(body.payload.summary).toContain("Sorokeep alert");
        expect(body.payload.source).toBe("CABC1234");
        expect(body.payload.custom_details.currentRemainingLedgers).toBe(120);
        expect(body.payload.custom_details.configuredLedgers).toBe(1000);
        expect(body.payload.custom_details.entryKeyXdr).toBe("AAAA1");
        expect(body.dedup_key).toContain("sorokeep:testnet:CABC1234");
    });

    it("uses resolve event_action for alert_resolved", async () => {
        mockFetch.mockResolvedValue(makeOkResponse());
        const event = makeAlertEvent({ type: "alert_resolved", severity: "info" });

        await sendPagerDutyAlert("resolve-key", event);

        const [, options] = mockFetch.mock.calls[0]!;
        const body = JSON.parse(options.body as string);
        expect(body.event_action).toBe("resolve");
        expect(body.payload.severity).toBe("info");
    });

    it("throws when the PagerDuty API responds with a non-2xx status", async () => {
        mockFetch.mockResolvedValue(makeErrorResponse(500));

        await expect(sendPagerDutyAlert("test-routing-key", makeAlertEvent()))
            .rejects.toThrow("PagerDuty API request failed: HTTP 500");
    });
});
