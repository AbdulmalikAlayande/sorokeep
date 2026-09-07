import { describe, it, expect } from "vitest";
import { extractContractIds } from "../src/contractId.js";

const VALID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("extractContractIds", () => {
    it("finds a single 56-char C-prefixed contract ID in plain text", () => {
        const matches = extractContractIds(`wallet.contract = "${VALID}";`);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.contractId).toBe(VALID);
        expect(matches[0]!.start).toBeGreaterThanOrEqual(0);
        expect(matches[0]!.end - matches[0]!.start).toBe(56);
    });

    it("finds multiple contract IDs in one document", () => {
        const other = "CC7MAY3Y7WPF2PYTJT22PUPQLYLMLLHZSVCEQYS6G7P2QPQDGDCOBBCR";
        const matches = extractContractIds(`[${VALID}, ${other}]`);
        expect(matches.map((m) => m.contractId)).toEqual([VALID, other]);
    });

    it("ignores consecutive chunks of a 56-char C-string split across tokens", () => {
        const matches = extractContractIds(`"${VALID.slice(0, 6)}" + "${VALID.slice(6)}"`);
        expect(matches).toHaveLength(0);
    });

    it("ignores a C-prefixed string that is too short (55 chars)", () => {
        expect(extractContractIds(VALID.slice(0, 55))).toHaveLength(0);
    });

    it("ignores a C-prefixed string that is too long (57 chars)", () => {
        expect(extractContractIds(`${VALID}X`)).toHaveLength(0);
    });

    it("ignores lowercase and G-prefixed account keys", () => {
        const lower = VALID.toLowerCase();
        const account = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        expect(extractContractIds(lower)).toHaveLength(0);
        expect(extractContractIds(account)).toHaveLength(0);
    });

    it("returns empty for input with no matches", () => {
        expect(extractContractIds("const x = 42; // nothing here")).toEqual([]);
        expect(extractContractIds("")).toEqual([]);
    });

    it("does not carry stale regex state between calls (reuse-safe)", () => {
        extractContractIds(VALID);
        const again = extractContractIds("none");
        expect(again).toEqual([]);
    });
});