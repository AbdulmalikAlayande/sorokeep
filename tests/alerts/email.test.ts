import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Transporter } from "nodemailer";

// ─── Mock nodemailer before importing the module under test ───────────────────

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
    const mockSendMail = vi.fn();
    const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }) as unknown as Transporter);
    return { mockSendMail, mockCreateTransport };
});

vi.mock("nodemailer", () => ({
    default: { createTransport: mockCreateTransport },
    createTransport: mockCreateTransport,
}));

import { sendEmailAlert } from "../../src/alerts/email";
import type { AlertEvent } from "../../src/alerts/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SMTP_CONFIG = {
    host: "smtp.example.com",
    port: 587,
    user: "alerts@example.com",
    password: "secret",
    from: "alerts@example.com",
};

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
        timestamp: "2026-06-24T14:00:00.000Z",
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sendEmailAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSendMail.mockResolvedValue({ messageId: "test-message-id" });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // =========================================================================
    // 1. SMTP TRANSPORT CREATION
    // =========================================================================
    describe("Transport creation", () => {
        it("creates a transporter with the provided SMTP config", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            expect(mockCreateTransport).toHaveBeenCalledOnce();
            const transportConfig = mockCreateTransport.mock.calls[0]![0] as Record<string, unknown>;
            expect(transportConfig.host).toBe(SMTP_CONFIG.host);
            expect(transportConfig.port).toBe(SMTP_CONFIG.port);
        });

        it("includes auth credentials in the transport config", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const transportConfig = mockCreateTransport.mock.calls[0]![0] as Record<string, unknown>;
            const auth = transportConfig.auth as Record<string, string>;
            expect(auth.user).toBe(SMTP_CONFIG.user);
            expect(auth.pass).toBe(SMTP_CONFIG.password);
        });
    });

    // =========================================================================
    // 2. EMAIL DELIVERY
    // =========================================================================
    describe("Email delivery", () => {
        it("calls sendMail to deliver the email", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            expect(mockSendMail).toHaveBeenCalledOnce();
        });

        it("sends to the correct recipient address", async () => {
            await sendEmailAlert("ops-team@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.to).toBe("ops-team@example.com");
        });

        it("uses the configured from address", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.from).toBe(SMTP_CONFIG.from);
        });

        it("resolves without throwing on successful delivery", async () => {
            await expect(
                sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG),
            ).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // 3. EMAIL SUBJECT
    // =========================================================================
    describe("Email subject", () => {
        it("includes the contract name in the subject when present", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ contractName: "my-defi-pool" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.subject).toContain("my-defi-pool");
        });

        it("includes the contract ID in the subject when name is null", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ contractName: null }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.subject).toContain("CDEF1234ABCD5678");
        });

        it("includes a severity indicator in the subject for threshold_crossed events", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ severity: "critical" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(String(mailOptions.subject).toLowerCase()).toMatch(/critical|warning|alert/i);
        });

        it("indicates resolution in the subject for alert_resolved events", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ type: "alert_resolved", severity: "info" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(String(mailOptions.subject).toLowerCase()).toMatch(/resolved|recovered|ok/i);
        });
    });

    // =========================================================================
    // 4. HTML BODY CONTENT
    // =========================================================================
    describe("HTML body content", () => {
        it("sends an HTML email body", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.html).toBeDefined();
            expect(typeof mailOptions.html).toBe("string");
        });

        it("HTML body contains the contract name", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ contractName: "defi-pool-v2" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.html).toContain("defi-pool-v2");
        });

        it("HTML body contains the remaining TTL ledger count", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(String(mailOptions.html)).toMatch(/8.?500|8500/);
        });

        it("HTML body contains the network name", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ network: "mainnet" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.html).toContain("mainnet");
        });

        it("HTML body contains the approximate time remaining", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(mailOptions.html).toContain("~13h 0m");
        });

        it("HTML body includes severity for threshold_crossed events", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent({ severity: "critical" }), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(String(mailOptions.html).toLowerCase()).toContain("critical");
        });

        it("HTML body is valid HTML (starts with < tag)", async () => {
            await sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG);

            const mailOptions = mockSendMail.mock.calls[0]![0] as Record<string, unknown>;
            expect(String(mailOptions.html).trim()).toMatch(/^</);
        });
    });

    // =========================================================================
    // 5. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("throws when sendMail rejects", async () => {
            mockSendMail.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(
                sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG),
            ).rejects.toThrow("ECONNREFUSED");
        });

        it("throws when sendMail rejects with auth error", async () => {
            mockSendMail.mockRejectedValue(new Error("Invalid login"));

            await expect(
                sendEmailAlert("recipient@example.com", makeAlertEvent(), SMTP_CONFIG),
            ).rejects.toThrow("Invalid login");
        });

        it("throws a clear error when smtp config is missing host", async () => {
            const badConfig = { ...SMTP_CONFIG, host: "" };

            await expect(
                sendEmailAlert("recipient@example.com", makeAlertEvent(), badConfig),
            ).rejects.toThrow(/host/i);
        });

        it("throws a clear error when recipient address is empty", async () => {
            await expect(
                sendEmailAlert("", makeAlertEvent(), SMTP_CONFIG),
            ).rejects.toThrow(/recipient/i);
        });
    });
});
