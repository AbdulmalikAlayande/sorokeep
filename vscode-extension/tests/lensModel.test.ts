import { describe, it, expect } from "vitest";
import { renderCodeLensForStatus } from "../src/lensModel.js";
import type { ContractTtlStatus } from "../src/dbReader.js";
import type { TtlBucket } from "../src/ttlStatus.js";

function makeStatus(partial: {
    status: TtlBucket;
    remainingTTL: number | null;
    name?: string | null;
    contractId: string;
}): ContractTtlStatus {
    return {
        contractId: partial.contractId,
        name: partial.name ?? "USD Stablecoin Gateway",
        network: "testnet",
        lastCheckedLedger: 2_400_000,
        remainingTTL: partial.remainingTTL,
        approximateTimeRemaining:
            partial.remainingTTL == null ? null : `~${partial.remainingTTL} ledgers`,
        status: partial.status,
        entries: [],
    };
}

describe("renderCodeLensForStatus", () => {
    it("renders an ok lens for a healthy tracked contract", () => {
        const lens = renderCodeLensForStatus(
            makeStatus({ contractId: "C", status: "ok", remainingTTL: 300_000 }),
        )!;
        expect(lens).not.toBeNull();
        expect(lens.label).toContain("TTL");
        expect(lens.label).toMatch(/OK/);
    });

    it("renders a critical lens with the remaining-TTL detail", () => {
        const lens = renderCodeLensForStatus(
            makeStatus({ contractId: "C", status: "critical", remainingTTL: 3_500 }),
        )!;
        expect(lens.label).toMatch(/CRITICAL/);
        expect(lens.label).toContain("3,500");
    });

    it("renders null (no lens) for an unknown TTL, so untracked/unpolled contracts show nothing", () => {
        expect(
            renderCodeLensForStatus(
                makeStatus({ contractId: "C", status: "unknown", remainingTTL: null }),
            ),
        ).toBeNull();
    });
});