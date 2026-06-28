import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("nodemailer", async () => {
    const transport = {
        sendMail: vi.fn(),
    };

    const defaultExport = {
        createTransport: vi.fn(() => transport),
        __transport: transport,
    };

    return {
        __esModule: true,
        default: defaultExport,
    };
});

vi.mock("../../src/utils/config.js", () => ({
    __esModule: true,
    loadConfig: vi.fn(),
}));

import nodemailer from "nodemailer";
import { loadConfig } from "../../src/utils/config.js";
import { sendEmailAlert } from "../../src/alerts/email.js";
import type { AlertEvent } from "../../src/alerts/types.js";

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

function makeSmtpConfig() {
    return {
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUser: "alerts@example.com",
        smtpPass: "secret-password",
    };
}

describe("sendEmailAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const transport = (nodemailer as any).__transport;
        transport.sendMail = vi.fn().mockResolvedValue({ messageId: "message-id-123" });
        (loadConfig as any).mockReturnValue(makeSmtpConfig());
    });

    it("throws when SMTP config is missing", async () => {
        (loadConfig as any).mockReturnValue({});
        await expect(sendEmailAlert("ops@example.com", makeAlertEvent())).rejects.toThrow(/SMTP.*config/i);
    });

    it("creates SMTP transport using config values", async () => {
        await sendEmailAlert("ops@example.com", makeAlertEvent());

        expect((nodemailer as any).createTransport).toHaveBeenCalledWith({
            host: "smtp.example.com",
            port: 587,
            secure: false,
            auth: {
                user: "alerts@example.com",
                pass: "secret-password",
            },
        });

        const transport = (nodemailer as any).__transport;
        expect(transport.sendMail).toHaveBeenCalledTimes(1);
        const [mailOptions] = transport.sendMail.mock.calls[0]!;
        expect(mailOptions.to).toBe("ops@example.com");
        expect(mailOptions.subject).toContain("TTL Warning");
        expect(mailOptions.html).toContain("<!doctype html>");
        expect(mailOptions.text).toContain("TTL Warning");
    });

    it("renders an alert resolved subject and body", async () => {
        await sendEmailAlert("ops@example.com", makeAlertEvent({ type: "alert_resolved" }));
        const transport = (nodemailer as any).__transport;
        const [mailOptions] = transport.sendMail.mock.calls[0]!;
        expect(mailOptions.subject).toContain("Alert Resolved");
        expect(mailOptions.text).toContain("Alert Resolved");
    });

    it("includes contract name and network in the email body", async () => {
        await sendEmailAlert("ops@example.com", makeAlertEvent({ contractName: "defi-pool-v2", network: "testnet" }));
        const transport = (nodemailer as any).__transport;
        const [mailOptions] = transport.sendMail.mock.calls[0]!;
        expect(mailOptions.html).toContain("defi-pool-v2");
        expect(mailOptions.html).toContain("testnet");
        expect(mailOptions.text).toContain("defi-pool-v2");
        expect(mailOptions.text).toContain("testnet");
    });
});
