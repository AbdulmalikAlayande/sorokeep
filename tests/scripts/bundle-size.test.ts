import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePackOutput,
  parseSize,
  formatBytes,
  compareSizes,
  checkBundleSize,
} from "../../scripts/bundle-size.mjs";

// ---------------------------------------------------------------------------
// parseSize
// ---------------------------------------------------------------------------
describe("parseSize", () => {
  it("parses bytes without suffix", () => {
    expect(parseSize("1024")).toBe(1024);
  });

  it("parses kilobytes (kB)", () => {
    expect(parseSize("1.5 kB")).toBe(1536);
  });

  it("parses kilobytes (KB)", () => {
    expect(parseSize("2 KB")).toBe(2048);
  });

  it("parses kibibytes (KiB)", () => {
    expect(parseSize("1 KiB")).toBe(1024);
  });

  it("parses megabytes (MB)", () => {
    expect(parseSize("1.23 MB")).toBe(Math.round(1.23 * 1024 * 1024));
  });

  it("parses megabytes without decimal", () => {
    expect(parseSize("5MB")).toBe(5 * 1024 * 1024);
  });

  it("parses gigabytes (GB)", () => {
    expect(parseSize("1 GB")).toBe(1024 ** 3);
  });

  it("handles numbers with commas", () => {
    expect(parseSize("1,024 B")).toBe(1024);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseSize("")).toBe(0);
    expect(parseSize("nope")).toBe(0);
  });

  it("handles trailing whitespace", () => {
    expect(parseSize("  42 kB  ")).toBe(42 * 1024);
  });
});

// ---------------------------------------------------------------------------
// parsePackOutput
// ---------------------------------------------------------------------------
describe("parsePackOutput", () => {
  it("extracts unpacked size from npm pack --dry-run text output", () => {
    const stdout = [
      "npm pack using dry-run mode",
      "",
      "npm warn tarball tarball will be packed to stdout",
      "",
      "total files: 120",
      "Package size:  123.4 kB",
      "Unpacked size: 1.23 MB",
    ].join("\n");

    expect(parsePackOutput(stdout)).toBe(
      Math.round(1.23 * 1024 * 1024),
    );
  });

  it("handles lowercase 'unpacked size'", () => {
    const stdout = "total unpacked size: 456.7 kB\n";
    expect(parsePackOutput(stdout)).toBe(Math.round(456.7 * 1024));
  });

  it("returns null when no size line is present", () => {
    const stdout = "no useful info here\n";
    expect(parsePackOutput(stdout)).toBeNull();
  });

  it("handles size in bytes", () => {
    const stdout = "Unpacked size: 2048 B\n";
    expect(parsePackOutput(stdout)).toBe(2048);
  });

  it("handles npm pack --dry-run --json empty stdout", () => {
    expect(parsePackOutput("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(1024 * 10)).toBe("10.0 kB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(Math.round(1.5 * 1024 ** 2))).toBe("1.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

// ---------------------------------------------------------------------------
// compareSizes
// ---------------------------------------------------------------------------
describe("compareSizes", () => {
  it("returns exceeded:false when baseline is null (no published version)", () => {
    const result = compareSizes(5000, null, 10);
    expect(result.exceeded).toBe(false);
    expect(result.baseline).toBeNull();
    expect(result.changePercent).toBeNull();
  });

  it("returns exceeded:false when baseline is 0", () => {
    const result = compareSizes(5000, 0, 10);
    expect(result.exceeded).toBe(false);
    expect(result.baseline).toBe(0);
  });

  it("returns exceeded:false when size is unchanged", () => {
    const result = compareSizes(1000, 1000, 10);
    expect(result.exceeded).toBe(false);
    expect(result.changePercent).toBe(0);
  });

  it("returns exceeded:false when increase is within threshold", () => {
    const result = compareSizes(1050, 1000, 10);
    expect(result.exceeded).toBe(false);
    expect(result.changePercent).toBeCloseTo(5);
  });

  it("returns exceeded:true when increase exceeds threshold", () => {
    const result = compareSizes(1200, 1000, 10);
    expect(result.exceeded).toBe(true);
    expect(result.changePercent).toBeCloseTo(20);
  });

  it("returns exceeded:false when size decreases", () => {
    const result = compareSizes(800, 1000, 10);
    expect(result.exceeded).toBe(false);
    expect(result.changePercent).toBe(-20);
  });

  it("exactly at threshold IS exceeded (inclusive)", () => {
    const result = compareSizes(1100, 1000, 10);
    expect(result.exceeded).toBe(true);
    expect(result.changePercent).toBeCloseTo(10);
  });

  it("just under threshold is NOT exceeded", () => {
    const result = compareSizes(1099, 1000, 10);
    expect(result.exceeded).toBe(false);
  });

  it("uses default threshold of 10 when not provided", () => {
    expect(compareSizes(1099, 1000).exceeded).toBe(false);
    expect(compareSizes(1100, 1000).exceeded).toBe(true);
  });

  it("supports custom threshold", () => {
    expect(compareSizes(105, 100, 5).exceeded).toBe(true);
    expect(compareSizes(104, 100, 5).exceeded).toBe(false);
  });

  it("reports correct values in the result object", () => {
    const result = compareSizes(1500, 1000, 10);
    expect(result).toEqual({
      current: 1500,
      baseline: 1000,
      changePercent: 50,
      exceeded: true,
    });
  });
});

// ---------------------------------------------------------------------------
// checkBundleSize (integration-style with mocked execSync)
// ---------------------------------------------------------------------------
describe("checkBundleSize", () => {
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock child_process.execSync used inside the module
    vi.mock("node:child_process", () => ({
      execSync: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports success when size is within threshold", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    // First call: npm pack --dry-run --json
    execSyncMock
      .mockReturnValueOnce(
        JSON.stringify({ unpackedSize: 1000000 }),
      )
      // Second call: npm view sorokeep dist.unpackedSize
      .mockReturnValueOnce("1100000");

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 10,
    });

    expect(result.success).toBe(true);
    expect(result.current).toBe(1000000);
    expect(result.baseline).toBe(1100000);
    expect(result.message).toContain("kB");
  });

  it("reports failure when size exceeds threshold", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    execSyncMock
      .mockReturnValueOnce(
        JSON.stringify({ unpackedSize: 2000000 }),
      )
      .mockReturnValueOnce("1000000");

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 10,
    });

    expect(result.success).toBe(false);
    expect(result.baseline).toBe(1000000);
    expect(result.message).toContain("Threshold: 10%");
  });

  it("handles no baseline published on npm", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    execSyncMock
      .mockReturnValueOnce(
        JSON.stringify({ unpackedSize: 500000 }),
      )
      // npm view fails (throws)
      .mockImplementationOnce(() => {
        throw new Error("npm ERR! code E404");
      });

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 10,
    });

    expect(result.success).toBe(true);
    expect(result.baseline).toBeNull();
    expect(result.message).toContain("no published baseline found");
  });

  it("falls back to text parsing when JSON parsing fails", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    // Return text output (not JSON)
    const textOutput = [
      "npm pack using dry-run mode",
      "Unpacked size: 1.5 MB",
    ].join("\n");

    execSyncMock
      .mockReturnValueOnce(textOutput)
      .mockReturnValueOnce("1500000");

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 10,
    });

    expect(result.success).toBe(true);
    expect(result.current).toBe(Math.round(1.5 * 1024 * 1024));
  });

  it("returns failure when pack output cannot be parsed", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    execSyncMock
      .mockReturnValueOnce("totally invalid output with no size info")
      .mockReturnValueOnce("1000");

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 10,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to determine package size");
  });

  it("default threshold is 10%", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    // 5% increase should be OK with default threshold
    execSyncMock
      .mockReturnValueOnce(JSON.stringify({ unpackedSize: 105000 }))
      .mockReturnValueOnce("100000");

    const result = await checkBundleSize({ packageName: "sorokeep" });
    expect(result.success).toBe(true);
  });

  it("respects custom threshold", async () => {
    const { execSync } = await import("node:child_process");
    execSyncMock = vi.mocked(execSync);

    // 5% increase should fail with 3% threshold
    execSyncMock
      .mockReturnValueOnce(JSON.stringify({ unpackedSize: 105000 }))
      .mockReturnValueOnce("100000");

    const result = await checkBundleSize({
      packageName: "sorokeep",
      threshold: 3,
    });
    expect(result.success).toBe(false);
  });
});
