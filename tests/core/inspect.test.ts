import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
    parseSacBalance,
    buildSacBalanceKeyXdr,
    formatTokenBalance,
    inspectContract,
    decodeScVal,
} from "../../src/core/inspect";
import { StellarRpcClient } from "../../src/rpc/client";
import * as dbLib from "../../src/db/database";
import * as repoLib from "../../src/db/repositories";

describe("SAC Decoder Core", () => {
    describe("formatTokenBalance", () => {
        it("correctly decodes and prints address balance decimals (7 decimals)", () => {
            expect(formatTokenBalance(10500000n, 7)).toBe("1.05");
            expect(formatTokenBalance(10000000n, 7)).toBe("1");
            expect(formatTokenBalance(1234567n, 7)).toBe("0.1234567");
            expect(formatTokenBalance(0n, 7)).toBe("0");
        });

        it("correctly formats balances with 2 decimals", () => {
            expect(formatTokenBalance(150n, 2)).toBe("1.5");
            expect(formatTokenBalance(99n, 2)).toBe("0.99");
            expect(formatTokenBalance(100n, 2)).toBe("1");
        });

        it("correctly formats balances with 0 decimals", () => {
            expect(formatTokenBalance(1234n, 0)).toBe("1234");
        });

        it("correctly formats balances with 18 decimals", () => {
            expect(formatTokenBalance(1000000000000000000n, 18)).toBe("1");
            expect(formatTokenBalance(1500000000000000000n, 18)).toBe("1.5");
        });
    });

    describe("parseSacBalance", () => {
        it("builds custom parser for SAC balance map layout and decodes fields", () => {
            // Create SAC balance map XDR: { amount: 25000000n, authorized: true, clawback: false }
            const map = xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("amount"),
                    val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 25000000n })),
                }),
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("authorized"),
                    val: xdr.ScVal.scvBool(true),
                }),
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("clawback"),
                    val: xdr.ScVal.scvBool(false),
                }),
            ]);
            const base64 = map.toXDR("base64");

            const decoded = parseSacBalance(base64);
            expect(decoded).toEqual({
                amount: 25000000n,
                authorized: true,
                clawback: false,
            });
        });

        it("handles ScVal object directly", () => {
            const map = xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("amount"),
                    val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 500n })),
                }),
            ]);
            const decoded = parseSacBalance(map);
            expect(decoded.amount).toBe(500n);
            expect(decoded.authorized).toBe(true);
        });

        it("throws error on invalid SAC balance layout", () => {
            const strVal = xdr.ScVal.scvString("not a map");
            expect(() => parseSacBalance(strVal)).toThrow("Invalid SAC balance map layout");
        });
    });

    describe("buildSacBalanceKeyXdr", () => {
        it("creates correct storage key XDR for balance slot", () => {
            const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
            const address = "GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW";
            const keyXdr = buildSacBalanceKeyXdr(contractId, address);

            const ledgerKey = xdr.LedgerKey.fromXDR(keyXdr, "base64");
            expect(ledgerKey.switch().name).toBe("contractData");
            const data = ledgerKey.contractData();
            expect(data.durability().name).toBe("persistent");

            const scValKey = data.key();
            expect(scValKey.switch().name).toBe("scvVec");
            const vec = scValKey.vec()!;
            expect(vec[0]!.sym().toString()).toBe("Balance");
            expect(vec[1]!.switch().name).toBe("scvAddress");
        });
    });

    describe("decodeScVal", () => {
        it("decodes u32 ScVal to JSON-compatible structure", () => {
            const scVal = xdr.ScVal.scvU32(42);
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvU32", value: 42 });
        });

        it("decodes i32 ScVal to JSON-compatible structure", () => {
            const scVal = xdr.ScVal.scvI32(-10);
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvI32", value: -10 });
        });

        it("decodes boolean ScVal", () => {
            const trueVal = xdr.ScVal.scvBool(true);
            const falseVal = xdr.ScVal.scvBool(false);
            expect(decodeScVal(trueVal.toXDR("base64"))).toEqual({ type: "scvBool", value: true });
            expect(decodeScVal(falseVal.toXDR("base64"))).toEqual({ type: "scvBool", value: false });
        });

        it("decodes string ScVal", () => {
            const scVal = xdr.ScVal.scvString("hello");
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvString", value: "hello" });
        });

        it("decodes symbol ScVal", () => {
            const scVal = xdr.ScVal.scvSymbol("MySymbol");
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvSymbol", value: "MySymbol" });
        });

        it("decodes u64 ScVal", () => {
            const scVal = xdr.ScVal.scvU64(new xdr.Uint64(999n));
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvU64", value: "999" });
        });

        it("decodes i128 ScVal", () => {
            const scVal = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 12345n }));
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvI128", value: "12345" });
        });

        it("decodes map ScVal", () => {
            const map = xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("name"),
                    val: xdr.ScVal.scvString("Alice"),
                }),
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("age"),
                    val: xdr.ScVal.scvU32(30),
                }),
            ]);
            const result = decodeScVal(map.toXDR("base64"));
            expect(result.type).toBe("scvMap");
            expect(result.value).toHaveLength(2);
            expect(result.value[0].key).toEqual({ type: "scvSymbol", value: "name" });
            expect(result.value[0].value).toEqual({ type: "scvString", value: "Alice" });
            expect(result.value[1].key).toEqual({ type: "scvSymbol", value: "age" });
            expect(result.value[1].value).toEqual({ type: "scvU32", value: 30 });
        });

        it("decodes vec ScVal", () => {
            const vec = xdr.ScVal.scvVec([
                xdr.ScVal.scvU32(1),
                xdr.ScVal.scvU32(2),
                xdr.ScVal.scvU32(3),
            ]);
            const result = decodeScVal(vec.toXDR("base64"));
            expect(result.type).toBe("scvVec");
            expect(result.value).toHaveLength(3);
            expect(result.value[0]).toEqual({ type: "scvU32", value: 1 });
        });

        it("decodes bytes ScVal", () => {
            const scVal = xdr.ScVal.scvBytes(Buffer.from("deadbeef", "hex"));
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result.type).toBe("scvBytes");
            expect(result.value).toBe("deadbeef");
        });

        it("decodes void ScVal", () => {
            const scVal = xdr.ScVal.scvVoid();
            const result = decodeScVal(scVal.toXDR("base64"));
            expect(result).toEqual({ type: "scvVoid", value: null });
        });

        it("returns error structure for invalid XDR", () => {
            const result = decodeScVal("not-valid-base64-xdr!!!");
            expect(result.type).toBe("error");
            expect(result.value).toContain("Failed to decode");
        });
    });

    describe("inspectContract", () => {
        beforeEach(() => {
            vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("fails gracefully on non-SAC contracts", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue(null);
            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue({
                entryKeyXdr: "AAAA",
                latestLedger: 100,
                liveUntilLedgerSeq: 200,
                lastModifiedLedgerSeq: 50,
                remainingTTL: 100,
                executableType: "contractExecutableWasm",
                wasmHash: "1234",
            });

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: ["balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW"],
                network: "testnet",
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("not a standard Stellar Asset Contract (SAC)");
        });

        it("fails gracefully when contract instance not found", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue(null);
            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue(null);

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: ["balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW"],
                network: "testnet",
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("not found on-chain");
        });

        it("correctly locates balance slots and decodes balance decimals on SAC contract", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue({
                id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                network: "testnet",
                name: "Native XLM",
            });

            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue({
                entryKeyXdr: "AAAA",
                latestLedger: 100,
                liveUntilLedgerSeq: 200,
                lastModifiedLedgerSeq: 50,
                remainingTTL: 100,
                executableType: "contractExecutableStellarAsset",
                wasmHash: null,
            });

            vi.spyOn(StellarRpcClient.prototype, "getEntryTTLs").mockResolvedValue({
                latestLedger: 100,
                entries: [
                    {
                        entryKeyXdr: "DUMMY_KEY_XDR",
                        latestLedger: 100,
                        liveUntilLedgerSeq: 5000,
                        lastModifiedLedgerSeq: 90,
                        remainingTTL: 4900,
                    },
                ],
            });

            const expectedKeyXdr = buildSacBalanceKeyXdr("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW");

            // Mock getContractStorageEntries
            vi.spyOn(StellarRpcClient.prototype as any, "getContractStorageEntries").mockResolvedValue([
                {
                    entryKeyXdr: expectedKeyXdr,
                    latestLedger: 100,
                    liveUntilLedgerSeq: 5000,
                    lastModifiedLedgerSeq: 90,
                    remainingTTL: 4900,
                    valXdr: xdr.ScVal.scvMap([
                        new xdr.ScMapEntry({
                            key: xdr.ScVal.scvSymbol("amount"),
                            val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 10500000n })),
                        }),
                        new xdr.ScMapEntry({
                            key: xdr.ScVal.scvSymbol("authorized"),
                            val: xdr.ScVal.scvBool(true),
                        }),
                        new xdr.ScMapEntry({
                            key: xdr.ScVal.scvSymbol("clawback"),
                            val: xdr.ScVal.scvBool(false),
                        }),
                    ]).toXDR("base64"),
                },
            ]);

            vi.spyOn(StellarRpcClient.prototype as any, "getSacDecimals").mockResolvedValue(7);

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: ["balance:GBEA5Z3MBTLHEQHZYU3GUZIKABRADWJSOSD62GHBIVUUAWRMXTU6U2EW"],
            });

            expect(result.success).toBe(true);
            expect(result.isSac).toBe(true);
            expect(result.decimals).toBe(7);
            expect(result.results).toHaveLength(1);
            expect(result.results![0]!.formattedBalance).toBe("1.05");
            expect(result.results![0]!.balance!.amount).toBe(10500000n);
        });

        it("fetches and prints valid JSON for raw entry on non-SAC contracts", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue({
                id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                network: "testnet",
                name: "MyContract",
            });

            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue({
                entryKeyXdr: "AAAA",
                latestLedger: 100,
                liveUntilLedgerSeq: 200,
                lastModifiedLedgerSeq: 50,
                remainingTTL: 100,
                executableType: "contractExecutableWasm",
                wasmHash: "abcd1234",
            });

            const valScVal = xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("counter"),
                    val: xdr.ScVal.scvU32(42),
                }),
            ]);

            const fakeKeyXdr = "AAABBB";
            vi.spyOn(StellarRpcClient.prototype as any, "getContractStorageEntries").mockResolvedValue([
                {
                    entryKeyXdr: fakeKeyXdr,
                    latestLedger: 100,
                    liveUntilLedgerSeq: 5000,
                    lastModifiedLedgerSeq: 90,
                    remainingTTL: 4900,
                    valXdr: valScVal.toXDR("base64"),
                },
            ]);

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: [fakeKeyXdr],
                network: "testnet",
            });

            expect(result.success).toBe(true);
            expect(result.isSac).toBe(false);
            expect(result.results).toHaveLength(1);
            const entry = result.results![0]!;
            expect(entry.type).toBe("raw");
            expect(entry.found).toBe(true);
            expect(entry.decodedValue).toBeDefined();
            expect(entry.decodedValue!.type).toBe("scvMap");
            // Verify it's valid JSON-serializable
            const jsonStr = JSON.stringify(entry.decodedValue);
            expect(() => JSON.parse(jsonStr)).not.toThrow();
        });

        it("prints error if target key is not active on-chain", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue({
                id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                network: "testnet",
                name: "MyContract",
            });

            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue({
                entryKeyXdr: "AAAA",
                latestLedger: 100,
                liveUntilLedgerSeq: 200,
                lastModifiedLedgerSeq: 50,
                remainingTTL: 100,
                executableType: "contractExecutableWasm",
                wasmHash: "abcd1234",
            });

            // Return empty — key not found on-chain
            vi.spyOn(StellarRpcClient.prototype as any, "getContractStorageEntries").mockResolvedValue([]);

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: ["NONEXISTENT_KEY_XDR"],
                network: "testnet",
            });

            expect(result.success).toBe(true);
            expect(result.results).toHaveLength(1);
            const entry = result.results![0]!;
            expect(entry.found).toBe(false);
            expect(entry.status).toBe("unknown");
            expect(entry.decodedValue).toBeUndefined();
        });

        it("returns results with no entries when --entry is not specified on non-SAC contract", async () => {
            vi.spyOn(repoLib, "getContract").mockReturnValue({
                id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                network: "testnet",
                name: "MyContract",
            });

            vi.spyOn(StellarRpcClient.prototype, "getContractInstanceEntry").mockResolvedValue({
                entryKeyXdr: "AAAA",
                latestLedger: 100,
                liveUntilLedgerSeq: 200,
                lastModifiedLedgerSeq: 50,
                remainingTTL: 100,
                executableType: "contractExecutableWasm",
                wasmHash: "abcd1234",
            });

            const result = await inspectContract({} as any, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", {
                entries: [],
                network: "testnet",
            });

            expect(result.success).toBe(true);
            expect(result.isSac).toBe(false);
            expect(result.results).toHaveLength(0);
        });
    });
});
