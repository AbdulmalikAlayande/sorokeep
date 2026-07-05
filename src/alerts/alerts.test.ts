import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Implementation Code ---
export type AlertEventType = "budget_exhausted" | "system_error";
export type AlertSeverity = "warning" | "error" | "info";

export interface AlertEvent {
  type: AlertEventType;
  severity: AlertSeverity;
  contractId: string;
  message: string;
  timestamp: number;
}

export interface NotificationChannel {
  type: "slack" | "webhook" | "discord";
  send: (event: AlertEvent) => Promise<{ success: boolean }>;
}

export class AlertDispatcher {
  private channels: NotificationChannel[];

  constructor(channels: NotificationChannel[]) {
    this.channels = channels;
  }

  async dispatchEvent(event: AlertEvent): Promise<void> {
    const deliveryPromises = this.channels.map(async (channel) => {
      try {
        await channel.send(event);
      } catch (error) {
        console.error(`[AlertDispatcher] Delivery failed for: ${channel.type}`, error);
      }
    });
    await Promise.all(deliveryPromises);
  }
}

// --- Test Suite ---
describe("TDD - Alert Dispatcher Budget Exhaustion Engine", () => {
  let mockSlackChannel: any;
  let mockWebhookChannel: any;

  beforeEach(() => {
    mockSlackChannel = {
      type: "slack",
      send: vi.fn().mockResolvedValue({ success: true }),
    };
    mockWebhookChannel = {
      type: "webhook",
      send: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it("should successfully dispatch warning alerts to channels when a contract budget is exhausted", async () => {
    const dispatcher = new AlertDispatcher([mockSlackChannel, mockWebhookChannel]);
    
    const exhaustiveEvent: AlertEvent = {
      type: "budget_exhausted",
      severity: "warning",
      contractId: "CC7...SOROBAN",
      message: "Auto-extension blocked: budget allocation completely exhausted.",
      timestamp: Date.now(),
    };

    await dispatcher.dispatchEvent(exhaustiveEvent);

    expect(mockSlackChannel.send).toHaveBeenCalledTimes(1);
    expect(mockSlackChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        type: "budget_exhausted",
      })
    );

    expect(mockWebhookChannel.send).toHaveBeenCalledTimes(1);
    expect(mockWebhookChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: "CC7...SOROBAN",
      })
    );
  });

  it("should handle channel failures gracefully without crashing execution flow", async () => {
    mockSlackChannel.send.mockRejectedValueOnce(new Error("Slack Timeout"));
    
    const dispatcher = new AlertDispatcher([mockSlackChannel, mockWebhookChannel]);
    const exhaustiveEvent: AlertEvent = {
      type: "budget_exhausted",
      severity: "warning",
      contractId: "CC7...SOROBAN",
      message: "Auto-extension blocked.",
      timestamp: Date.now(),
    };

    await expect(dispatcher.dispatchEvent(exhaustiveEvent)).resolves.not.toThrow();
    expect(mockWebhookChannel.send).toHaveBeenCalledTimes(1);
  });
});