import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock fetch before importing the module under test ────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendDiscordAlert } from "../../src/alerts/discord";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789/abcdefghijklmnop";

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

function makeDiscordOkResponse(): Response {
    // Discord returns 204 No Content on successful webhook POST
    return new Response(null, { status: 204 });
}

function makeDiscordErrorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendDiscordAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    // =========================================================================
    // 1. WEBHOOK URL VALIDATION
    // =========================================================================
    describe("Webhook URL validation", () => {
        it("throws a clear error when webhookUrl is empty", async () => {
            await expect(
                sendDiscordAlert("", makeAlertEvent()),
            ).rejects.toThrow(/webhook/i);
        });

        it("throws a clear error when webhookUrl is not a valid Discord URL", async () => {
            await expect(
                sendDiscordAlert("not-a-url", makeAlertEvent()),
            ).rejects.toThrow(/webhook/i);
        });

        it("posts to the provided Discord webhook URL", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            await sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent());

            const [url] = mockFetch.mock.calls[0]!;
            expect(url).toBe(VALID_WEBHOOK_URL);
        });
    });

    // =========================================================================
    // 2. HTTP REQUEST SHAPE
    // =========================================================================
    describe("HTTP request shape", () => {
        it("uses HTTP POST", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            await sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.method).toBe("POST");
        });

        it("sets Content-Type to application/json", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            await sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Content-Type"]).toBe("application/json");
        });

        it("sends a body with an embeds array", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            await sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(Array.isArray(body.embeds)).toBe(true);
            expect(body.embeds.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 3. EMBED CONTENT
    // =========================================================================
    describe("Embed content", () => {
        it("includes the contract name in the embed title", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ contractName: "defi-pool-v2" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const embed = body.embeds[0];
            const searchable = JSON.stringify(embed);
            expect(searchable).toContain("defi-pool-v2");
        });

        it("falls back to contractId when contractName is null", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ contractName: null, contractId: "CABCD1234" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const searchable = JSON.stringify(body.embeds[0]);
            expect(searchable).toContain("CABCD1234");
        });

        it("includes the network name in the embed", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ network: "mainnet" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(JSON.stringify(body.embeds[0])).toContain("mainnet");
        });

        it("includes the remaining TTL in the embed", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({
                threshold: {
                    configuredLedgers: 10_000,
                    currentRemainingLedgers: 4_200,
                    approximateTimeRemaining: "~6h 25m",
                },
            });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const searchable = JSON.stringify(body.embeds[0]);
            expect(searchable).toMatch(/4.?200|4200/); // 4,200 or 4200
        });

        it("includes the approximate time remaining in the embed", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent();

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(JSON.stringify(body.embeds[0])).toContain("~6h 25m");
        });
    });

    // =========================================================================
    // 4. SEVERITY COLOR CODING  (acceptance criteria)
    // =========================================================================
    describe("Severity color coding", () => {
        it("uses red color (0xFF0000) for critical severity", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ severity: "critical" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.embeds[0].color).toBe(0xFF0000);
        });

        it("uses orange/yellow color (0xFFA500) for warning severity", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ severity: "warning" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.embeds[0].color).toBe(0xFFA500);
        });

        it("uses green color (0x00CC44) for info / resolved severity", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ type: "alert_resolved", severity: "info" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.embeds[0].color).toBe(0x00CC44);
        });

        it("embed color differs between critical and warning events", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            const criticalEvent = makeAlertEvent({ severity: "critical" });
            await sendDiscordAlert(VALID_WEBHOOK_URL, criticalEvent);
            const criticalBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
            const criticalColor = criticalBody.embeds[0].color;

            vi.clearAllMocks();
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            const warningEvent = makeAlertEvent({ severity: "warning" });
            await sendDiscordAlert(VALID_WEBHOOK_URL, warningEvent);
            const warningBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
            const warningColor = warningBody.embeds[0].color;

            expect(criticalColor).not.toBe(warningColor);
        });
    });

    // =========================================================================
    // 5. RESOLVED VS ACTIVE EVENTS
    // =========================================================================
    describe("Event type distinctions", () => {
        it("shows a resolved indicator in the title for alert_resolved events", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ type: "alert_resolved" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const title: string = body.embeds[0].title ?? "";
            expect(title.toLowerCase()).toMatch(/resolved|recovered|✅|ok/i);
        });

        it("shows a warning/alert indicator in the title for threshold_crossed events", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());
            const event = makeAlertEvent({ type: "threshold_crossed", severity: "warning" });

            await sendDiscordAlert(VALID_WEBHOOK_URL, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            const title: string = body.embeds[0].title ?? "";
            expect(title.toLowerCase()).toMatch(/warning|alert|⚠|ttl|critical/i);
        });
    });

    // =========================================================================
    // 6. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws when Discord returns a non-2xx HTTP status", async () => {
            mockFetch.mockResolvedValue(
                makeDiscordErrorResponse(400, "Invalid Webhook Token"),
            );

            await expect(
                sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent()),
            ).rejects.toThrow(/400|Invalid Webhook/i);
        });

        it("throws when Discord returns 404 (webhook not found)", async () => {
            mockFetch.mockResolvedValue(
                makeDiscordErrorResponse(404, "Unknown Webhook"),
            );

            await expect(
                sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent()),
            ).rejects.toThrow(/404|Unknown Webhook/i);
        });

        it("throws when fetch itself rejects (network error)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent()),
            ).rejects.toThrow("ECONNREFUSED");
        });

        it("throws when Discord returns HTTP 429 (rate limited)", async () => {
            mockFetch.mockResolvedValue(
                makeDiscordErrorResponse(429, "You are being rate limited"),
            );

            await expect(
                sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent()),
            ).rejects.toThrow(/429|rate limit/i);
        });
    });

    // =========================================================================
    // 7. OPTIONAL: username branding
    // =========================================================================
    describe("Branding", () => {
        it("sets a username field in the webhook payload", async () => {
            mockFetch.mockResolvedValue(makeDiscordOkResponse());

            await sendDiscordAlert(VALID_WEBHOOK_URL, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(typeof body.username).toBe("string");
            expect(body.username.length).toBeGreaterThan(0);
        });
    });
});