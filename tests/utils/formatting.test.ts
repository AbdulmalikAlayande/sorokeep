import { describe, it, expect } from "vitest";
import { convertLedgerCloseTimeToSeconds, formatTimeToCloseLedger, classifyTTL, statusIndicator, formatContractID } from "../../src/utils/formatting";

describe("convertLedgerCloseTimeToSeconds", () => {
    it("should convert ledger close time to seconds using 5.5s average", () => {
        expect(convertLedgerCloseTimeToSeconds(1)).toBeCloseTo(5.5);
        expect(convertLedgerCloseTimeToSeconds(10)).toBeCloseTo(55);
        expect(convertLedgerCloseTimeToSeconds(0)).toBeCloseTo(0);
    });

    it("handles large ledger counts", () => {
        expect(convertLedgerCloseTimeToSeconds(1000)).toBeCloseTo(5500);
        expect(convertLedgerCloseTimeToSeconds(10000)).toBeCloseTo(55000);
    });
});

describe("formatTimeToCloseLedger", () => {
    it("returns 'Ledger Expired' for zero or negative ledger counts", () => {
        expect(formatTimeToCloseLedger(0)).toBe("Ledger Expired"); 
        expect(formatTimeToCloseLedger(-5)).toBe("Ledger Expired");
    });

    it("formats time correctly for various ledger counts", () => {
        expect(formatTimeToCloseLedger(1)).toBe("~0m 5.5s");
        expect(formatTimeToCloseLedger(10)).toBe("~0m 55s");
        expect(formatTimeToCloseLedger(11)).toBe("~1m 0.5s");
        expect(formatTimeToCloseLedger(100)).toBe("~9m 10s");
        expect(formatTimeToCloseLedger(1000)).toBe("~1h 31m");
        expect(formatTimeToCloseLedger(20000)).toBe("~1d 6h");
        expect(formatTimeToCloseLedger(50000)).toBe("~3d 4h");
        expect(formatTimeToCloseLedger(100000)).toBe("~6d 8h");
    });

    it("handles very large ledger counts (e.g. 1 year)", () => {
        // 1 year is approx 31,536,000 seconds
        // Ledgers: 31,536,000 / 5.5 = 5,733,818
        expect(formatTimeToCloseLedger(6000000)).toBe("~381d 22h");
    });
});

describe("classifyTTL", () => {
    it("classifies expired TTL", () => {
        expect(classifyTTL(0)).toBe("expired");
        expect(classifyTTL(-1)).toBe("expired");
    });
    it("classifies critical TTL (below 5000)", () => {
        expect(classifyTTL(1)).toBe("critical");
        expect(classifyTTL(4999)).toBe("critical");
    });
    it("classifies warning TTL (5000 to 19999)", () => {
        expect(classifyTTL(5000)).toBe("warning");
        expect(classifyTTL(19999)).toBe("warning");
    });
    it("classifies ok TTL (20000 and above)", () => {
        expect(classifyTTL(20000)).toBe("ok");
        expect(classifyTTL(100000)).toBe("ok");
    });
});

describe("statusIndicator", () => {
  it("returns correct indicator for each status", () => {
    expect(statusIndicator("ok")).toContain("OK");
    expect(statusIndicator("warning")).toContain("WARNING");
    expect(statusIndicator("critical")).toContain("CRITICAL");
    expect(statusIndicator("expired")).toContain("EXPIRED");
  });
});

describe("formatContractID", () => {
  it("returns full contract ID if it's shorter than max length", () => {
    const id = "CABDEf123456";
    expect(formatContractID(id)).toBe(id);
  });
  it("returns truncated contract ID with ellipsis if it's longer than max length", () => {
    const id = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    const formatted = formatContractID(id);
    expect(formatted).toBe("CBEOJUP5...KZW6");
    expect(formatted.length).toBeLessThan(id.length);
  });
   it("respects custom maxLength", () => {
    const id = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    const formatted = formatContractID(id, 56);
    expect(formatted).toBe(id);
    expect(formatted.length).toBe(56);
  });

  it("handles very short custom maxLength", () => {
    const id = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    // If maxLength is e.g. 5, it should still truncate correctly using 8+ellipsis+4 pattern 
    // Wait, the current implementation doesn't care about maxLength for the truncation logic itself, 
    // it just checks IF it should truncate.
    expect(formatContractID(id, 5)).toBe("CBEOJUP5...KZW6");
  });

  it.skip("TODO: Implement XDR entry key decoding for better labeling", () => {
    // Phase 1/2 feature to make the 'status' output more readable
  });
});
