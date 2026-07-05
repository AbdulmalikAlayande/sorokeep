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