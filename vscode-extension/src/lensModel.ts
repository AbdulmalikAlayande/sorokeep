import type { ContractTtlStatus } from "./dbReader.js";
import type { TtlBucket } from "./ttlStatus.js";

function emojiFor(bucket: TtlBucket): string {
    switch (bucket) {
        case "ok":
            return "🟢";
        case "warning":
            return "🟡";
        case "critical":
            return "🔴";
        case "expired":
            return "⛔";
        default:
            return "⚪";
    }
}

export interface RenderedCodeLens {
    label: string;
}

/**
 * Turn a contract's TTL status into a CodeLens label. Returns null when the
 * status is unknown (contract tracked but never polled) so the provider emits
 * no lens — matching the "no CodeLens for untracked contracts" acceptance
 * criterion rather than surfacing speculative status.
 */
export function renderCodeLensForStatus(status: ContractTtlStatus): RenderedCodeLens | null {
    if (status.status === "unknown" || status.remainingTTL == null) return null;

    const displayName = status.name ?? status.contractId;
    const label =
        `${emojiFor(status.status)} ${displayName}: ` +
        `TTL ${status.approximateTimeRemaining ?? "?"} ` +
        `(${status.remainingTTL.toLocaleString()} ledgers) ` +
        `[${status.status.toUpperCase()}]`;

    return { label };
}