import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
    parseSacBalance,
    buildSacBalanceKeyXdr,
    formatTokenBalance,
    inspectContract,
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
            expect(result.error).toContain("Contract instance not found");
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
    });
});
