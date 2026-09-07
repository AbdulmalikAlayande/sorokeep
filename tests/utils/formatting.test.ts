import { describe, it, expect } from "vitest";
import { convertLedgerCloseTimeToSeconds, formatTimeToCloseLedger, classifyTTL, statusIndicator, formatContractID, formatSecretKey, validateContractId, paginateList, formatPaginationFooter, formatBytes, formatFleetCSV } from "../../src/utils/formatting";

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

describe("formatBytes", () => {
  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
  it("formats positive bytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1 MB");
  });
  it("formats negative bytes", () => {
    expect(formatBytes(-1024)).toBe("-1 KB");
    expect(formatBytes(-1536)).toBe("-1.5 KB");
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

describe("formatSecretKey", () => {
  it("masks a valid Stellar secret key showing first 4 and last 4 characters", () => {
    const key = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(formatSecretKey(key)).toBe("SAAA...AAAA");
  });

  it("returns the original string for env:VAR_NAME references", () => {
    expect(formatSecretKey("env:MY_SECRET_KEY")).toBe("env:MY_SECRET_KEY");
    expect(formatSecretKey("env:SECRET_VAR_42")).toBe("env:SECRET_VAR_42");
  });

  it("returns the original string for short keys that cannot be masked", () => {
    expect(formatSecretKey("S")).toBe("S");
    expect(formatSecretKey("S123")).toBe("S123");
  });

  it("returns null or empty string as-is", () => {
    expect(formatSecretKey(null)).toBeNull();
    expect(formatSecretKey("")).toBe("");
  });

  it("masks even a malformed long key starting with S", () => {
    const long = "S" + "X".repeat(60);
    expect(formatSecretKey(long)).toBe("SXXX...XXXX");
  });

  it("does not mask keys that do not start with S", () => {
    expect(formatSecretKey("GABCDEF123456789")).toBe("GABCDEF123456789");
    expect(formatSecretKey("raw-text")).toBe("raw-text");
  });

  it("produces exactly 11 characters for a 56-char Stellar secret key", () => {
    const key = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(formatSecretKey(key).length).toBe(11);
  });
});

describe("validateContractId", () => {
  const VALID_CONTRACT_ID = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
  const ACCOUNT_ADDRESS = "GABCDEF123456789012345678901234567890123456789012345678";

  it("accepts a valid contract ID", () => {
    expect(validateContractId(VALID_CONTRACT_ID)).toEqual({ valid: true });
  });

  it("rejects an empty or missing ID", () => {
    const result = validateContractId("");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/empty or missing/);
  });

  it("rejects a wrong-prefix ID with a distinct reason (account address)", () => {
    const result = validateContractId(ACCOUNT_ADDRESS);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/must start with 'C'/);
      expect(result.reason).toMatch(/account address/);
    }
  });

  it("rejects a too-short ID with a distinct reason", () => {
    const result = validateContractId("CSHORT");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/56 characters/);
  });

  it("rejects a checksum-invalid ID with a distinct reason", () => {
    const badChecksum = VALID_CONTRACT_ID.slice(0, -1) + (VALID_CONTRACT_ID.endsWith("A") ? "B" : "A");
    const result = validateContractId(badChecksum);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/invalid Stellar checksum/);
  });

  it("produces distinct reasons across all failure modes", () => {
    const reasons = [
      validateContractId(""),
      validateContractId(ACCOUNT_ADDRESS),
      validateContractId("CSHORT"),
      validateContractId(VALID_CONTRACT_ID.slice(0, -1) + (VALID_CONTRACT_ID.endsWith("A") ? "B" : "A")),
    ].map((r) => (r.valid ? null : r.reason));

    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("paginateList", () => {
  it("returns the first page with the correct slice when page-size is smaller than total", () => {
    const items = Array.from({ length: 60 }, (_, i) => `item-${i + 1}`);
    const result = paginateList(items, 1, 25);

    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toBe("item-1");
    expect(result.items[24]).toBe("item-25");
    expect(result.meta).toEqual({ page: 1, pageSize: 25, totalItems: 60, totalPages: 3 });
  });

  it("returns the second page with items 26-50", () => {
    const items = Array.from({ length: 60 }, (_, i) => `item-${i + 1}`);
    const result = paginateList(items, 2, 25);

    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toBe("item-26");
    expect(result.items[24]).toBe("item-50");
    expect(result.meta.page).toBe(2);
  });

  it("returns the third page with the remaining 10 items", () => {
    const items = Array.from({ length: 60 }, (_, i) => `item-${i + 1}`);
    const result = paginateList(items, 3, 25);

    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toBe("item-51");
    expect(result.items[9]).toBe("item-60");
    expect(result.meta.page).toBe(3);
  });

  it("clamps an out-of-range page number to the last page", () => {
    const items = Array.from({ length: 60 }, (_, i) => `item-${i + 1}`);
    const result = paginateList(items, 99, 25);

    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toBe("item-51");
    expect(result.meta.page).toBe(3);
  });

  it("clamps a page number below 1 up to the first page", () => {
    const items = Array.from({ length: 60 }, (_, i) => `item-${i + 1}`);
    const result = paginateList(items, 0, 25);

    expect(result.meta.page).toBe(1);
    expect(result.items[0]).toBe("item-1");
  });

  it("returns empty items with a single total page for empty input", () => {
    const result = paginateList([], 1, 25);

    expect(result.items).toHaveLength(0);
    expect(result.meta).toEqual({ page: 1, pageSize: 25, totalItems: 0, totalPages: 1 });
  });

  it("defaults pageSize to 25 when not provided", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const result = paginateList(items, 1);

    expect(result.items).toHaveLength(25);
    expect(result.meta.pageSize).toBe(25);
  });
});

describe("formatPaginationFooter", () => {
  it("formats the footer with page, total pages, and total count", () => {
    expect(formatPaginationFooter({ page: 1, pageSize: 25, totalItems: 60, totalPages: 3 }))
      .toBe("Page 1 of 3 (60 total)");
  });

  it("handles a single page", () => {
    expect(formatPaginationFooter({ page: 1, pageSize: 25, totalItems: 5, totalPages: 1 }))
      .toBe("Page 1 of 1 (5 total)");
  });
});

describe("formatFleetCSV", () => {
  it("returns a header row plus one row per entry", () => {
    const rows = formatFleetCSV([
      {
        contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
        contractName: "Alpha",
        entryKeyXdr: "AAAA1234",
        entryType: "instance",
        remainingTTL: 50000,
        status: "ok",
      },
      {
        contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
        contractName: "Alpha",
        entryKeyXdr: "AAAA5678",
        entryType: "wasm",
        remainingTTL: 48000,
        status: "ok",
      },
    ]);

    const lines = rows.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe("contract_id,contract_name,entry_key_xdr,entry_type,remaining_ttl,status");
  });

  it("quotes a contract name containing a comma", () => {
    const rows = formatFleetCSV([
      {
        contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
        contractName: "DeFi, Protocol",
        entryKeyXdr: "AAAA1234",
        entryType: "instance",
        remainingTTL: 30000,
        status: "warning",
      },
    ]);

    const lines = rows.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    // The name "DeFi, Protocol" must be quoted
    expect(lines[1]).toContain('"DeFi, Protocol"');
  });

  it("escapes a contract name containing double quotes", () => {
    const rows = formatFleetCSV([
      {
        contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
        contractName: 'Token "V2"',
        entryKeyXdr: "AAAA1234",
        entryType: "persistent",
        remainingTTL: 5000,
        status: "critical",
      },
    ]);

    const lines = rows.split("\n").filter((l) => l.length > 0);
    expect(lines[1]).toContain('"Token ""V2"""');
  });

  it("handles a null contract name gracefully", () => {
    const rows = formatFleetCSV([
      {
        contractId: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6",
        contractName: null,
        entryKeyXdr: "AAAA1234",
        entryType: "instance",
        remainingTTL: 0,
        status: "expired",
      },
    ]);

    const lines = rows.split("\n").filter((l) => l.length > 0);
    expect(lines[1]).toContain("CBEOJUP5...");
  });

  it("returns only the header row for an empty input", () => {
    const rows = formatFleetCSV([]);
    const lines = rows.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("contract_id,contract_name,entry_key_xdr,entry_type,remaining_ttl,status");
  });
});
