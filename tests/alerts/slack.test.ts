import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { SlackChannel } from "../../src/alerts/slack";
import type { AlertEvent } from "../../src/alerts/types";

const VALID_WEBHOOK = "https://example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";

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
    return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html" },
    });
}

function makeSlackErrorResponse(error: string): Response {
    return new Response(error, {
        status: 400,
        headers: { "content-type": "text/html" },
    });
}

describe("SlackChannel", () => {
    let channel: SlackChannel;

    beforeEach(() => {
        vi.clearAllMocks();
        channel = new SlackChannel(VALID_WEBHOOK);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    describe("Webhook URL validation", () => {
        it("throws a clear error when URL is missing", async () => {
            expect(() => new SlackChannel("")).toThrow(/webhook URL/);
        });
        it("throws when URL is invalid", async () => {
            expect(() => new SlackChannel("not-a-url")).toThrow(/webhook URL/);
        });
    });

    describe("HTTP request shape", () => {
        it("calls the provided webhook URL", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            await channel.send(makeAlertEvent());
            const [url] = mockFetch.mock.calls[0]!;
            expect(url).toBe(VALID_WEBHOOK);
        });

        it("uses HTTP POST", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            await channel.send(makeAlertEvent());
            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.method).toBe("POST");
        });

        it("sets Content-Type to application/json", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            await channel.send(makeAlertEvent());
            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Content-Type"]).toBe("application/json");
        });
    });

    describe("Message content", () => {
        it("includes the contract name in the message blocks", async () => {
            mockFetch.mockResolvedValue(makeSlackOkResponse());
            const event = makeAlertEvent({ contractName: "defi-pool-v2" });
            await channel.send(event);
            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(JSON.stringify(body.blocks)).toContain("defi-pool-v2");
        });
    });

    describe("Error handling", () => {
        it("throws when API returns non-2xx", async () => {
            mockFetch.mockResolvedValue(makeSlackErrorResponse("invalid_payload"));
            await expect(channel.send(makeAlertEvent())).rejects.toThrow("invalid_payload");
        });

        it("throws when fetch itself rejects (network error)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
            await expect(channel.send(makeAlertEvent())).rejects.toThrow("ECONNREFUSED");
        });
    });
});
