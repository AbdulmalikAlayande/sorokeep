import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/utils/config";

// ─── Mock loadConfig to prevent fallback to real ~/.sorokeep/config.yaml ──────

vi.mock("../../src/utils/config", () => ({
    loadConfig: vi.fn(() => ({})),
}));

// ─── Mock fetch before importing the module under test ────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendTelegramAlert } from "../../src/alerts/telegram";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const VALID_CHAT_ID = "-1001234567890";

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

function makeOkResponse(): Response {
    return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

function makeTelegramErrorResponse(description: string): Response {
    return new Response(
        JSON.stringify({ ok: false, description }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendTelegramAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
        process.env["SOROKEEP_TELEGRAM_BOT_TOKEN"] = VALID_BOT_TOKEN;
    });

    afterEach(() => {
        delete process.env["SOROKEEP_TELEGRAM_BOT_TOKEN"];
        vi.unstubAllGlobals();
        vi.stubGlobal("fetch", mockFetch);
    });

    // =========================================================================
    // 1. TOKEN VALIDATION
    // =========================================================================
    describe("Token validation", () => {
        it("throws a clear error when no bot token is configured", async () => {
            delete process.env["SOROKEEP_TELEGRAM_BOT_TOKEN"];

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toThrow(/[Tt]elegram.*[Tt]oken|[Tt]oken.*[Tt]elegram/);
        });

        it("throws when SOROKEEP_TELEGRAM_BOT_TOKEN is an empty string", async () => {
            process.env["SOROKEEP_TELEGRAM_BOT_TOKEN"] = "";

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toThrow(/[Tt]elegram.*[Tt]oken|[Tt]oken.*[Tt]elegram/);
        });

        it("uses the bot token in the API URL", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [url] = mockFetch.mock.calls[0]!;
            expect(url).toContain(VALID_BOT_TOKEN);
        });
    });

    // =========================================================================
    // 2. HTTP REQUEST SHAPE
    // =========================================================================
    describe("HTTP request shape", () => {
        it("calls the Telegram sendMessage API endpoint", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [url] = mockFetch.mock.calls[0]!;
            expect(url).toContain("sendMessage");
        });

        it("uses HTTP POST", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.method).toBe("POST");
        });

        it("sets Content-Type to application/json", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.headers["Content-Type"]).toBe("application/json");
        });

        it("sends the correct chat_id in the body", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.chat_id).toBe(VALID_CHAT_ID);
        });

        it("sets parse_mode to MarkdownV2 or Markdown in the body", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.parse_mode).toMatch(/^Markdown(V2)?$/);
        });

        it("sets a signal for abort / timeout control", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            expect(options.signal).toBeDefined();
        });
    });

    // =========================================================================
    // 3. MESSAGE CONTENT
    // =========================================================================
    describe("Message content", () => {
        it("includes the contract name in the message text", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ contractName: "defi-pool-v2" });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            // MarkdownV2 escapes hyphens as \-, so check for the escaped or unescaped form
            expect(body.text).toMatch(/defi[\\-]*pool[\\-]*v2/);
        });

        it("includes the remaining TTL in the message", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({
                threshold: {
                    configuredLedgers: 10_000,
                    currentRemainingLedgers: 4_200,
                    approximateTimeRemaining: "~6h 25m",
                },
            });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.text).toMatch(/4[,.]?200|~6h 25m/);
        });

        it("includes the network name in the message", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ network: "mainnet" });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.text).toContain("mainnet");
        });

        it("uses a warning indicator for threshold_crossed events", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ type: "threshold_crossed" });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.text.toLowerCase()).toMatch(/warning|⚠|alert|critical|ttl/i);
        });

        it("uses a resolved indicator for alert_resolved events", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ type: "alert_resolved" });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.text.toLowerCase()).toMatch(/resolved|recovered|✅|ok/i);
        });

        it("falls back gracefully when contractName is null", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ contractName: null });

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, event),
            ).resolves.not.toThrow();
        });

        it("includes the contractId when contractName is null", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());
            const event = makeAlertEvent({ contractName: null, contractId: "CDEF1234ABCD5678" });

            await sendTelegramAlert(VALID_CHAT_ID, event);

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(body.text).toContain("CDEF1234ABCD5678");
        });

        it("includes a non-empty text field", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent());

            const [, options] = mockFetch.mock.calls[0]!;
            const body = JSON.parse(options.body as string);
            expect(typeof body.text).toBe("string");
            expect(body.text.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 4. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws when Telegram API returns ok: false", async () => {
            mockFetch.mockResolvedValue(makeTelegramErrorResponse("chat not found"));

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toThrow("chat not found");
        });

        it("throws when Telegram API returns ok: false with Unauthorized", async () => {
            mockFetch.mockResolvedValue(makeTelegramErrorResponse("Unauthorized"));

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toThrow("Unauthorized");
        });

        it("throws when fetch itself rejects (network error)", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toThrow("ECONNREFUSED");
        });

        it("throws on HTTP 500 from Telegram", async () => {
            mockFetch.mockResolvedValue(
                new Response("Internal Server Error", { status: 500 }),
            );

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).rejects.toBeDefined();
        });

        it("resolves without throwing on successful delivery", async () => {
            mockFetch.mockResolvedValue(makeOkResponse());

            await expect(
                sendTelegramAlert(VALID_CHAT_ID, makeAlertEvent()),
            ).resolves.not.toThrow();
        });
    });
});
