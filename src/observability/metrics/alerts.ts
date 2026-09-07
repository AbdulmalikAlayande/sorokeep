import { Counter, Histogram } from "prom-client";

export const alertsDeliveredTotal = new Counter({
    name: "sorokeep_alerts_delivered_total",
    help: "Total number of alerts successfully delivered, labelled by channel type",
    labelNames: ["channel_type"] as const,
});

export const alertsFailedTotal = new Counter({
    name: "sorokeep_alerts_failed_total",
    help: "Total number of alert delivery attempts that failed (including ones that will be retried), labelled by channel type",
    labelNames: ["channel_type"] as const,
});

export const alertsAbandonedTotal = new Counter({
    name: "sorokeep_alerts_abandoned_total",
    help: "Total number of alerts abandoned after exhausting all retries, labelled by channel type",
    labelNames: ["channel_type"] as const,
});

export const alertDeliveryDurationSeconds = new Histogram({
    name: "sorokeep_alert_delivery_duration_seconds",
    help: "Duration of each alert delivery attempt in seconds, labelled by channel type",
    labelNames: ["channel_type"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
