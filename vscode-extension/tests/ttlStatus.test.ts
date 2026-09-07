import { describe, it, expect } from "vitest";
import {
    classifyRemainingTTL,
    formatTimeToCloseLedger,
    reduceContractStatus,
} from "../src/ttlStatus.js";
import type { TtlBucket } from "../src/ttlStatus.js";

describe("classifyRemainingTTL (mirrors sorokeep classifyTTL thresholds)", () => {
    it("classifies expired at zero or negative remaining ledgers", () => {
        expect(classifyRemainingTTL(0)).toBe("expired");
        expect(classifyRemainingTTL(-100)).toBe("expired");
    });

    it("classifies critical below 5000 ledgers", () => {
        expect(classifyRemainingTTL(1)).toBe("critical");
        expect(classifyRemainingTTL(4999)).toBe("critical");
    });

    it("classifies warning from 5000 up to 20000 ledgers", () => {
        expect(classifyRemainingTTL(5000)).toBe("warning");
        expect(classifyRemainingTTL(19999)).toBe("warning");
    });

    it("classifies ok at 20000 or more ledgers", () => {
        expect(classifyRemainingTTL(20000)).toBe("ok");
        expect(classifyRemainingTTL(2_000_000)).toBe("ok");
    });
});

describe("formatTimeToCloseLedger", () => {
    it("formats hours/minutes for sub-day remaining TTL", () => {
        // 9,500 ledgers * 5.5s = 52,250s = 14.5h = "~14h 30m"
        expect(formatTimeToCloseLedger(9500)).toBe("~14h 30m");
    });

    it("formats days/hours for multi-day remaining TTL", () => {
        // 20,000 ledgers * 5.5s = 110,000s = ~1d 6h
        expect(formatTimeToCloseLedger(20000)).toBe("~1d 6h");
    });

    it("handles zero remaining TTL without throwing", () => {
        expect(() => formatTimeToCloseLedger(0)).not.toThrow();
    });
});

describe("reduceContractStatus", () => {
    const entries = (
        rows: Array<{ label: string; remainingTTL: number | null }>,
    ): any[] =>
        rows.map((r) => ({
            label: r.label,
            entryType: "instance",
            liveUntilLedger: r.remainingTTL == null ? null : 2_400_000 + r.remainingTTL,
            remainingTTL: r.remainingTTL,
            approximateTimeRemaining:
                r.remainingTTL == null ? null : formatTimeToCloseLedger(r.remainingTTL),
            status: r.remainingTTL == null ? ("unknown" as TtlBucket) : classifyRemainingTTL(r.remainingTTL),
        }));

    it("picks the most urgent (minimum remaining TTL) entry", () => {
        const reduced = reduceContractStatus(
            entries([
                { label: "Instance", remainingTTL: 100_000 },
                { label: "WASM Code", remainingTTL: 4_000 },
            ]) as any,
        );
        expect(reduced.status).toBe("critical");
        expect(reduced.remainingTTL).toBe(4000);
        expect(reduced.entryLabel).toBe("WASM Code");
    });

    it("treats a fully healthy contract as ok", () => {
        const reduced = reduceContractStatus(
            entries([{ label: "Instance", remainingTTL: 300_000 }]) as any,
        );
        expect(reduced.status).toBe("ok");
    });

    it("returns unknown when no entry has a known remaining TTL", () => {
        const reduced = reduceContractStatus(
            entries([
                { label: "Instance", remainingTTL: null },
                { label: "WASM Code", remainingTTL: null },
            ]) as any,
        );
        expect(reduced.status).toBe("unknown");
        expect(reduced.remainingTTL).toBeNull();
    });
});