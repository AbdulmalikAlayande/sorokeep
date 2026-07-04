/**
 * TDD tests for parseResourceEstimate and enhanced simulateExtension
 *
 * Written FIRST before the implementation (strict TDD — issues #133 and #137).
 *
 * Issue #133: parse resource limits from simulateTransaction response
 *   - parseResourceEstimate() must extract cpuInstructions, memoryBytes,
 *     and minResourceFee from a Soroban simulation response.
 *   - Returns a ResourceEstimate object on success.
 *   - Returns null / throws on error responses.
 *
 * Issue #137: edge case tests for simulation failures
 *   - Handles missing fields gracefully (defaults to 0).
 *   - Returns null for error simulation responses.
 *   - Returns null for null/undefined input.
 */

import { describe, it, expect } from "vitest";
import {
    parseResourceEstimate,
    type ResourceEstimate,
} from "../../src/rpc/client.js";

// ─── Mock simulation response shapes ─────────────────────────────────────────

/** A minimal successful simulation response as returned by simulateTransaction. */
function makeSuccessSimResponse(overrides: {
    minResourceFee?: string | number;
    cost?: { cpuInsns?: string | number; memBytes?: string | number };
} = {}): Record<string, unknown> {
    return {
        minResourceFee: String(overrides.minResourceFee ?? "1234"),
        cost: {
            cpuInsns: String(overrides.cost?.cpuInsns ?? "500000"),
            memBytes: String(overrides.cost?.memBytes ?? "1048576"),
        },
        // Simulate presence of a result (successful simulation)
        results: [{ xdr: "AAAAAA==" }],
        latestLedger: "100000",
    };
}

/** A simulation error response. */
function makeErrorSimResponse(error = "simulation failed"): Record<string, unknown> {
    return {
        error,
        latestLedger: "100000",
    };
}

// ─── Tests: parseResourceEstimate ────────────────────────────────────────────

describe("parseResourceEstimate", () => {
    it("extracts cpuInstructions, memoryBytes, and minResourceFee from a valid response", () => {
        const sim = makeSuccessSimResponse({
            minResourceFee: "2500",
            cost: { cpuInsns: "750000", memBytes: "2097152" },
        });

        const result = parseResourceEstimate(sim);
        expect(result).not.toBeNull();
        expect(result!.cpuInstructions).toBe(750_000);
        expect(result!.memoryBytes).toBe(2_097_152);
        expect(result!.minResourceFee).toBe(2_500);
    });

    it("returns a ResourceEstimate object with the correct shape", () => {
        const sim = makeSuccessSimResponse();
        const result = parseResourceEstimate(sim);

        expect(result).not.toBeNull();
        // Must have all three fields
        expect(typeof result!.cpuInstructions).toBe("number");
        expect(typeof result!.memoryBytes).toBe("number");
        expect(typeof result!.minResourceFee).toBe("number");
    });

    it("returns null for a simulation error response", () => {
        const sim = makeErrorSimResponse("Transaction simulation failed: invalid XDR");
        const result = parseResourceEstimate(sim);
        expect(result).toBeNull();
    });

    it("returns null when input is null", () => {
        const result = parseResourceEstimate(null);
        expect(result).toBeNull();
    });

    it("returns null when input is undefined", () => {
        const result = parseResourceEstimate(undefined);
        expect(result).toBeNull();
    });

    it("returns null when input is an empty object", () => {
        const result = parseResourceEstimate({});
        expect(result).toBeNull();
    });

    it("handles minResourceFee as a numeric string", () => {
        const sim = makeSuccessSimResponse({ minResourceFee: "9999" });
        const result = parseResourceEstimate(sim);
        expect(result!.minResourceFee).toBe(9_999);
    });

    it("handles minResourceFee as a number (not a string)", () => {
        const sim = makeSuccessSimResponse({ minResourceFee: 4321 });
        const result = parseResourceEstimate(sim);
        expect(result!.minResourceFee).toBe(4_321);
    });

    it("handles cpuInsns and memBytes as numeric strings", () => {
        const sim = makeSuccessSimResponse({
            cost: { cpuInsns: "123456", memBytes: "654321" },
        });
        const result = parseResourceEstimate(sim);
        expect(result!.cpuInstructions).toBe(123_456);
        expect(result!.memoryBytes).toBe(654_321);
    });

    it("defaults cpuInstructions to 0 when cost.cpuInsns is missing", () => {
        const sim = makeSuccessSimResponse();
        // Remove cpuInsns
        (sim.cost as Record<string, unknown>).cpuInsns = undefined;
        const result = parseResourceEstimate(sim);
        expect(result!.cpuInstructions).toBe(0);
    });

    it("defaults memoryBytes to 0 when cost.memBytes is missing", () => {
        const sim = makeSuccessSimResponse();
        (sim.cost as Record<string, unknown>).memBytes = undefined;
        const result = parseResourceEstimate(sim);
        expect(result!.memoryBytes).toBe(0);
    });

    it("defaults minResourceFee to 0 when missing", () => {
        const sim: Record<string, unknown> = {
            cost: { cpuInsns: "100", memBytes: "200" },
            results: [{ xdr: "AAAAAA==" }],
            latestLedger: "100000",
        };
        const result = parseResourceEstimate(sim);
        expect(result!.minResourceFee).toBe(0);
    });

    it("returns fee-only behavior when cost field is absent entirely", () => {
        const sim: Record<string, unknown> = {
            minResourceFee: "100",
            results: [{ xdr: "AAAAAA==" }],
            latestLedger: "100000",
        };
        const result = parseResourceEstimate(sim);
        expect(result).toEqual({
            cpuInstructions: 0,
            memoryBytes: 0,
            minResourceFee: 100
        });
    });

    it("returns null when input is not an object (e.g. a string)", () => {
        const result = parseResourceEstimate("not an object" as unknown);
        expect(result).toBeNull();
    });

    it("returns null when input is a number", () => {
        const result = parseResourceEstimate(42 as unknown);
        expect(result).toBeNull();
    });

    it("handles large numeric strings without precision loss (BigInt-safe range)", () => {
        const largeButSafe = "9007199254740991"; // Number.MAX_SAFE_INTEGER
        const sim = makeSuccessSimResponse({
            minResourceFee: largeButSafe,
            cost: { cpuInsns: largeButSafe, memBytes: largeButSafe },
        });
        const result = parseResourceEstimate(sim);
        expect(result!.minResourceFee).toBe(Number.MAX_SAFE_INTEGER);
        expect(result!.cpuInstructions).toBe(Number.MAX_SAFE_INTEGER);
        expect(result!.memoryBytes).toBe(Number.MAX_SAFE_INTEGER);
    });

    // ─── Issue #137: Simulation failure edge cases ─────────────────────────

    describe("simulation failure edge cases (#137)", () => {
        it("returns null when the error field is present alongside partial data", () => {
            const sim = {
                error: "some RPC error",
                minResourceFee: "100",
                cost: { cpuInsns: "1000", memBytes: "2000" },
            };
            // Even with partial data, an error field should result in null
            const result = parseResourceEstimate(sim);
            expect(result).toBeNull();
        });

        it("does not throw when cost values are non-numeric strings", () => {
            const sim = makeSuccessSimResponse();
            (sim.cost as Record<string, unknown>).cpuInsns = "not-a-number";
            (sim.cost as Record<string, unknown>).memBytes = "NaN";
            expect(() => parseResourceEstimate(sim)).not.toThrow();
        });

        it("returns 0 (or null) when cost values are non-parseable — never NaN", () => {
            const sim = makeSuccessSimResponse();
            (sim.cost as Record<string, unknown>).cpuInsns = "bad";
            const result = parseResourceEstimate(sim);
            if (result !== null) {
                expect(Number.isNaN(result.cpuInstructions)).toBe(false);
            }
        });

        it("handles a response with a zero minResourceFee correctly", () => {
            const sim = makeSuccessSimResponse({ minResourceFee: "0" });
            const result = parseResourceEstimate(sim);
            expect(result!.minResourceFee).toBe(0);
        });

        it("handles a response with zero cpu/mem usage correctly", () => {
            const sim = makeSuccessSimResponse({
                cost: { cpuInsns: "0", memBytes: "0" },
            });
            const result = parseResourceEstimate(sim);
            expect(result!.cpuInstructions).toBe(0);
            expect(result!.memoryBytes).toBe(0);
        });
    });
});
