import { describe, it, expect, vi, beforeEach } from "vitest";
import { StellarRpcClient } from "../../src/rpc/client";
import { Contract } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () =>  {
    const actualModule = await vi.importActual("@stellar/stellar-sdk");
    const moduleRPC = actualModule.rpc as Record<string, unknown>;

    class MockRPCServer {

        async getHealth() {
            return { status: "healthy", latestLedger: 2443398, oldestLedger: 2322439, ledgerRetentionWindow: 120960 };
        }

        async getFeeStats() {
            return {
                latestLedger: 2443398,
                inclusionFee: {
                    max: "250",
                    min: "100",
                    mode: "100",
                    p10: "100",
                    p20: "100",
                    p30: "100",
                    p40: "100",
                    p50: "125",
                    p60: "150",
                    p70: "175",
                    p80: "200",
                    p90: "225",
                    p95: "250",
                    p99: "250",
                },
            };
        }

        /*
        Returns mock entries that match actual real life Stellar RPC response, matching the expected response
         */
        async getLedgerEntries(...keys: any[]) {
            return {
                latestLedger: 2443398,
                entries: keys.map(k => ({
                    lastModifiedLedgerSeq: 2400000,
                    liveUntilLedgerSeq: 2543398,
                    key: k,
                    val: {
                        contractData: () => ({
                            val: () => ({
                                instance: () => ({
                                    executable: () => ({
                                        switch: () => ({ name: "contractExecutableWasm" }),
                                        wasmHash: () => Buffer.from("ab".repeat(32), "hex"),
                                    }),
                                    storage: () => null,
                                }),
                            }),
                        }),
                    },
                    xdr: "mock-xdr"
                })),
            };
        }
    }

    return {
        ...actualModule,
        rpc: {
            moduleRPC,
            Server: MockRPCServer,
        },
    };
});

describe("StellarRpcClient", () => {
    let client: StellarRpcClient;

    beforeEach(() => {
        client = new StellarRpcClient("testnet")
    });

    describe("RPC Client Construction", () => {
        it('should create a client for the testnet network', () => {
            const testnetClient = new StellarRpcClient("testnet");
            expect(testnetClient).toBeDefined();
            expect(testnetClient.getNetwork()).toBe("testnet");
        });

        it('should create a client for the mainnet network', () => {
            const mainnetClient = new StellarRpcClient("mainnet");
            expect(mainnetClient).toBeDefined();
            expect(mainnetClient.getNetwork()).toBe("mainnet");
        });

        it('should create a client with a custom RPC url', () => {
            const customClient = new StellarRpcClient("testnet", "https://custom-rpc.com");
            expect(customClient).toBeDefined();
            expect(customClient.getNetwork()).toBe("testnet");
        });
    });

    describe("RPC Server Health Check", () => {
        it('should return the health status from the RPC server', async () => {
            const health = await client.checkHealth();
            expect(health.status).toBe("healthy");
            expect(health.latestLedger).toBe(2443398);
            expect(health.oldestLedger).toBe(2322439);
            expect(health.ledgerRetentionWindow).toBe(120960);
        });
    });

    describe("Contract Instance Entries Operations with `getContractInstanceEntry(contractID)`", () => {
        it('should return an instance entry with TTL data for a valid contract', async () => {
            const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
            const retrievedContractInstanceEntry = await client.getContractInstanceEntry(contractID);

            expect(retrievedContractInstanceEntry).toBeDefined();
            expect(retrievedContractInstanceEntry!.latestLedger).toBe(2443398);
            expect(retrievedContractInstanceEntry!.liveUntilLedgerSeq).toBe(2543398);
            expect(retrievedContractInstanceEntry!.lastModifiedLedgerSeq).toBe(2400000);
            expect(retrievedContractInstanceEntry!.remainingTTL).toBe(100000);
        });

        it('should extract the wasm_hash from an instance entry', async () => {
            const contractId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
            const retrievedContractInstanceEntry = await client.getContractInstanceEntry(contractId);

            expect(retrievedContractInstanceEntry!.executableType).toBe("contractExecutableWasm");
            expect(retrievedContractInstanceEntry!.wasmHash).toBeDefined();
            expect(retrievedContractInstanceEntry!.wasmHash).toHaveLength(64);
        });

        it("should return the entry key XDR for storage in the database as entry_key_xdr", async () => {
            const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
            const retrievedContractInstanceEntry = await client.getContractInstanceEntry(contractID);

            expect(retrievedContractInstanceEntry!.entryKeyXdr).toBeDefined();
            expect(typeof retrievedContractInstanceEntry!.entryKeyXdr).toBe("string");
        });
    });

    describe("Wasm Code Entry Operations with `getWasmCodeEntry(wasmHash)`",  () => {
        it('should return WASM code entry with TTL data', async () => {
            const wasmHash = "ab".repeat(32);
            const wasmCodeEntry = await client.getWasmCodeEntry(wasmHash);

            expect(wasmCodeEntry!.entryKeyXdr).toBeDefined();
            expect(wasmCodeEntry).toBeDefined();
            expect(wasmCodeEntry!.latestLedger).toBe(2443398);
            expect(wasmCodeEntry!.liveUntilLedgerSeq).toBe(2543398);
            expect(wasmCodeEntry!.remainingTTL).toBe(100000);
        });

        it("returns the entry key XDR for storage in the database", async () => {
            const wasmHash = "ab".repeat(32);
            const wasmCodeEntry = await client.getWasmCodeEntry(wasmHash);
            expect(wasmCodeEntry!.entryKeyXdr).toBeDefined();
            expect(typeof wasmCodeEntry!.entryKeyXdr).toBe("string");
        });
    });

    describe("getEntryTTLs", () => {
        it("accepts an array of base64 XDR keys and returns TTL data", async () => {
            const contract = new Contract("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6");
            const xdrKey = contract.getFootprint().toXDR("base64");
            const retrievedEntryTTLs = await client.getEntryTTLs([xdrKey]);
            expect(retrievedEntryTTLs).toBeDefined();
            expect(retrievedEntryTTLs.latestLedger).toBe(2443398);
            expect(retrievedEntryTTLs.entries).toHaveLength(1);
            // Verify that it correctly uses the passed key
            expect(retrievedEntryTTLs.entries[0]!.entryKeyXdr).toBe(xdrKey);
        });
    });

    describe("getCurrentLedger", () => {
        it("returns the current ledger number", async () => {
            const ledger = await client.getCurrentLedger();
            expect(ledger).toBe(2443398);
        });
    });

    describe("getFeeStats", () => {
        it("normalizes live fee stats for cost projection", async () => {
            const feeStats = await client.getFeeStats();

            expect(feeStats.latestLedger).toBe(2443398);
            expect(feeStats.baseFeeStroops).toBe(125);
            expect(feeStats.surgeFeeStroops).toBe(250);
            expect(feeStats.surgePricingMultiplier).toBe(2);
        });
    });
});
