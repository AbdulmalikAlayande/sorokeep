import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "../../src/alerts/types.js";

const mockSend = vi.fn();
const mockSNSClient = vi.fn().mockImplementation(() => ({ send: mockSend }));
const mockPublishCommand = vi.fn().mockImplementation((input) => input);

vi.mock("@aws-sdk/client-sns", () => ({
    SNSClient: mockSNSClient,
    PublishCommand: mockPublishCommand,
}));

vi.mock("@aws-sdk/credential-providers", () => ({
    defaultProvider: vi.fn(() => ({ accessKeyId: "test-access-key", secretAccessKey: "test-secret" })),
    fromIni: vi.fn(() => ({ accessKeyId: "test-access-key", secretAccessKey: "test-secret" })),
}));

const event: AlertEvent = {
    type: "threshold_crossed",
    severity: "critical",
    contractId: "contract-123",
    contractName: "demo-contract",
    network: "testnet",
    entry: {
        keyXdr: "key-xdr",
        type: "contract_data",
        label: "example",
    },
    threshold: {
        configuredLedgers: 100,
        currentRemainingLedgers: 12,
        approximateTimeRemaining: "~2h",
    },
    firedAtLedger: 42,
    timestamp: "2026-01-01T00:00:00.000Z",
};

describe("SNS alert channel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("publishes the serialized alert event to the configured SNS topic ARN", async () => {
        const { sendSnsAlert } = await import("../../src/alerts/sns.js");

        await sendSnsAlert("arn:aws:sns:us-east-1:123456789012:my-topic", event);

        expect(mockSNSClient).toHaveBeenCalledWith(expect.objectContaining({ region: "us-east-1" }));
        expect(mockPublishCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
                Message: JSON.stringify(event),
            }),
        );
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("rejects a malformed topic ARN before attempting to publish", async () => {
        const { sendSnsAlert } = await import("../../src/alerts/sns.js");

        await expect(sendSnsAlert("not-an-arn", event)).rejects.toThrow("Invalid SNS topic ARN");
        expect(mockSNSClient).not.toHaveBeenCalled();
        expect(mockPublishCommand).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });

    it("propagates SNS publish failures as thrown errors", async () => {
        mockSend.mockRejectedValueOnce(new Error("SNS publish failed"));
        const { sendSnsAlert } = await import("../../src/alerts/sns.js");

        await expect(sendSnsAlert("arn:aws:sns:us-east-1:123456789012:my-topic", event)).rejects.toThrow(
            "SNS publish failed",
        );
    });
});
