/* eslint-env node */
// @ts-check

/**
 * Bundle-size tracking script.
 *
 * Runs `npm pack --dry-run` to measure the unpacked size of the package tarball,
 * compares it against the last published version on npm, and flags a significant
 * increase.
 *
 * Exit codes:
 *   0 – size OK (or no baseline published yet)
 *   1 – size increased beyond threshold
 *
 * Environment variables:
 *   BUNDLE_SIZE_THRESHOLD – percentage increase that triggers failure (default: 10)
 */

import { execSync } from "node:child_process";

/**
 * Parse the human-readable size string from `npm pack --dry-run` output.
 * The last line of `npm pack --dry-run` contains the unpacked size, e.g.:
 *   "total files: …\nPackage size:  123.4 kB\nUnpacked size: 1.23 MB"
 *
 * @param {string} stdout – full stdout from `npm pack --dry-run`
 * @returns {number|null} unpacked size in bytes, or null if not found
 */
export function parsePackOutput(stdout) {
  // `npm pack --dry-run` (npm >= 9) prints "Unpacked size: <size>"
  // Older npm prints "total unpacked size: <size>"
  const match = stdout.match(/unpacked\s+size:\s*([\d.,]+\s*[kKmMgG]?i?B)/i);
  if (!match) return null;
  return parseSize(match[1]);
}

/**
 * Parse a human-readable byte string like "1.23 MB", "456.7 kB", "1024 B"
 * into an integer number of bytes.
 *
 * @param {string} sizeStr
 * @returns {number} bytes
 */
export function parseSize(sizeStr) {
  const trimmed = sizeStr.trim();
  const numMatch = trimmed.match(/^([\d.,]+)/);
  if (!numMatch) return 0;
  const num = parseFloat(numMatch[1].replace(/,/g, ""));
  const suffix = trimmed.slice(numMatch[1].length).trim().toUpperCase();

  const units = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
  };

  const multiplier = units[suffix] ?? 1;
  return Math.round(num * multiplier);
}

/**
 * Format a byte count into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string} e.g. "1.23 MB"
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Compare two sizes and return a result object.
 *
 * @param {number} currentSize – current unpacked size in bytes
 * @param {number|null} baselineSize – previous published size in bytes (null = no baseline)
 * @param {number} threshold – percentage increase that triggers failure (default 10)
 * @returns {{ current: number, baseline: number|null, changePercent: number|null, exceeded: boolean }}
 */
export function compareSizes(currentSize, baselineSize, threshold = 10) {
  if (baselineSize === null || baselineSize === 0) {
    return {
      current: currentSize,
      baseline: baselineSize,
      changePercent: null,
      exceeded: false,
    };
  }

  const changePercent = ((currentSize - baselineSize) / baselineSize) * 100;

  return {
    current: currentSize,
    baseline: baselineSize,
    changePercent,
    exceeded: changePercent >= threshold,
  };
}

/**
 * Fetch the unpacked size of the latest published version from the npm registry.
 *
 * @param {string} packageName
 * @returns {number|null} unpacked size in bytes, or null if package not found
 */
export async function fetchPublishedSize(packageName) {
  try {
    const stdout = execSync(`npm view ${packageName} dist.unpackedSize`, {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    const bytes = parseInt(stdout, 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Main entry point. Can be called from another script or run directly.
 *
 * @param {object} opts
 * @param {string} [opts.packageName='sorokeep']
 * @param {number} [opts.threshold=10]
 * @returns {Promise<{ success: boolean, current: number, baseline: number|null, message: string }>}
 */
export async function checkBundleSize({
  packageName = "sorokeep",
  threshold = 10,
} = {}) {
  // 1. Get current unpacked size
  // Note: no `2>/dev/null`-style fallback here — that's POSIX shell syntax
  // and breaks under the default shell execSync spawns on Windows (cmd.exe
  // can't resolve /dev/null), which silently falls through to a plain-text
  // `npm pack --dry-run` whose size details print to stderr rather than
  // stdout, so execSync never sees them. --json mode alone is sufficient;
  // any stderr npm writes alongside it doesn't affect the captured stdout.
  const packOutput = execSync("npm pack --dry-run --json", {
    encoding: "utf-8",
    timeout: 30_000,
  });

  let currentSize = null;

  // Try JSON output first (npm >= 9 with --json flag)
  try {
    const json = JSON.parse(packOutput);
    const entry = Array.isArray(json) ? json[0] : json;
    if (entry?.unpackedSize != null) {
      currentSize = entry.unpackedSize;
    }
  } catch {
    // Fall back to text parsing
  }

  if (currentSize === null) {
    currentSize = parsePackOutput(packOutput);
  }

  if (currentSize === null) {
    return {
      success: false,
      current: 0,
      baseline: null,
      message: "Failed to determine package size from npm pack output",
    };
  }

  // 2. Get published baseline size
  const baselineSize = await fetchPublishedSize(packageName);

  // 3. Compare
  const result = compareSizes(currentSize, baselineSize, threshold);

  // 4. Format message
  let message;
  if (result.baseline === null) {
    message = `Package unpacked size: ${formatBytes(currentSize)} (no published baseline found)`;
  } else if (result.exceeded) {
    message =
      `Package size increased by ${result.changePercent.toFixed(1)}% ` +
      `(${formatBytes(result.baseline)} → ${formatBytes(currentSize)}). ` +
      `Threshold: ${threshold}%.`;
  } else {
    const sign = result.changePercent >= 0 ? "+" : "";
    message =
      `Package unpacked size: ${formatBytes(currentSize)} ` +
      `(${sign}${result.changePercent.toFixed(1)}% from ${formatBytes(result.baseline)})`;
  }

  return {
    success: !result.exceeded,
    current: result.current,
    baseline: result.baseline,
    message,
  };
}

// Run when executed directly
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/bundle-size.mjs") ||
    process.argv[1].endsWith("\\bundle-size.mjs"));

if (isMainModule) {
  const threshold = parseInt(
    process.env.BUNDLE_SIZE_THRESHOLD ?? "10",
    10,
  );

  const result = await checkBundleSize({ threshold });

  console.log(`\n📦 Bundle Size Check`);
  console.log(`${result.message}\n`);

  if (!result.success) {
    console.error(`❌ Bundle size exceeded the ${threshold}% threshold.`);
    process.exit(1);
  } else {
    console.log(`✅ Bundle size within threshold.`);
  }
}
