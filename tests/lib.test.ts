/**
 * Library entry point smoke test.
 *
 * Verifies that `watchContract` and `runMonitorCycle` are exported from
 * the package's public library surface (`src/lib.ts`).  No RPC calls or
 * database I/O are performed — the test only checks that the symbols are
 * importable and are functions.
 */
import { describe, it, expect } from "vitest";
import { watchContract, runMonitorCycle, inspectContract, parseSacBalance, buildSacBalanceKeyXdr, formatTokenBalance } from "../src/lib.js";

describe("sorokeep library entry point", () => {
    it("exports watchContract as a function", () => {
        expect(typeof watchContract).toBe("function");
    });

    it("exports runMonitorCycle as a function", () => {
        expect(typeof runMonitorCycle).toBe("function");
    });

    it("exports inspectContract and helpers as functions", () => {
        expect(typeof inspectContract).toBe("function");
        expect(typeof parseSacBalance).toBe("function");
        expect(typeof buildSacBalanceKeyXdr).toBe("function");
        expect(typeof formatTokenBalance).toBe("function");
    });
});
