/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discoverStorageKeys, runBatchDiscovery } from "../../src/core/discovery";
import * as dbRepo from "../../src/db/repositories";
import { xdr, StrKey } from "@stellar/stellar-sdk";

vi.mock("../../src/db/repositories");

// Mock stellar-sdk RPC
vi.mock("@stellar/stellar-sdk", async () => {
    const actualModule = await vi.importActual<any>("@stellar/stellar-sdk");
    
    class MockRPCServer {
        public url: string;
        constructor(url: string) {
            this.url = url;
        }

        async getHealth() {
            if (this.url.includes("offline")) return { status: "offline" };
            return { latestLedger: 10000 };
        }

        async getEvents(_request: any) {
            if (this.url.includes("no-events")) return { events: [] };
            if (this.url.includes("throw-events")) throw new Error("RPC error fetching events");

            return {
                events: [
                    { txHash: "hash1" },
                    { txHash: "hash2" }, // Duplicate
                    { txHash: "hash3" }  // New
                ]
            };
        }

        async getTransaction(hash: string) {
            if (hash === "hash1" && this.url.includes("throw-tx")) {
                throw new Error("RPC error fetching tx");
            }
            if (this.url.includes("missing-entries")) {
                return { status: "SUCCESS" }; // no envelopeXdr
            }

            const contractIdStr = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
            const contractRaw = actualModule.StrKey.decodeContract(contractIdStr);
            const contractAddress = actualModule.xdr.ScAddress.scAddressTypeContract(contractRaw);

            // Construct footprint keys
            const keyVal1 = new actualModule.xdr.ScVal.scvString("hello_" + hash);
            const ledgerKey1 = actualModule.xdr.LedgerKey.contractData(
                new actualModule.xdr.LedgerKeyContractData({
                    contract: contractAddress,
                    key: keyVal1,
                    durability: actualModule.xdr.ContractDataDurability.persistent(),
                })
            );

            const keyVal2 = new actualModule.xdr.ScVal.scvString("world_" + hash);
            const ledgerKey2 = actualModule.xdr.LedgerKey.contractData(
                new actualModule.xdr.LedgerKeyContractData({
                    contract: contractAddress, // another key for the same contract
                    key: keyVal2,
                    durability: actualModule.xdr.ContractDataDurability.persistent(),
                })
            );

            // Also add a key for a different contract
            const otherContractIdStr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
            const otherContractRaw = actualModule.StrKey.decodeContract(otherContractIdStr);
            const otherContractAddress = actualModule.xdr.ScAddress.scAddressTypeContract(otherContractRaw);
            const otherLedgerKey = actualModule.xdr.LedgerKey.contractData(
                new actualModule.xdr.LedgerKeyContractData({
                    contract: otherContractAddress,
                    key: new actualModule.xdr.ScVal.scvString("other"),
                    durability: actualModule.xdr.ContractDataDurability.persistent(),
                })
            );

            const footprint = new actualModule.xdr.LedgerFootprint({
                readOnly: [ledgerKey1, otherLedgerKey],
                readWrite: [ledgerKey2]
            });

            // Put footprint in SorobanTransactionData
            const sorobanData = new actualModule.xdr.SorobanTransactionData({
                ext: new actualModule.xdr.ExtensionPoint(0),
                resources: new actualModule.xdr.SorobanResources({
                    footprint,
                    instructions: 0,
                    readBytes: 0,
                    writeBytes: 0
                }),
                resourceFee: actualModule.xdr.Int64.fromString("0")
            });


            const mockEnvelope = {
                switch: () => ({ name: 'envelopeTypeTx' }),
                v1: () => ({
                    tx: () => ({
                        ext: () => ({
                            switch: () => ({ value: 1 }),
                            v1: () => ({
                                sorobanData: () => sorobanData
                            })
                        })
                    })
                })
            };

            return {
                status: "SUCCESS",
                envelopeXdr: mockEnvelope,
            };
        }

        async getLedgerEntries(_key: any) {
            if (this.url.includes("missing-entries")) return { entries: [] };
            
            return {
                entries: [
                    { liveUntilLedgerSeq: 20000, lastModifiedLedgerSeq: 5000 }
                ]
            };
        }
    }

    return {
        ...actualModule,
        rpc: {
            ...actualModule.rpc,
            Server: MockRPCServer
        }
    };
});

describe("Discovery Core", () => {
    let mockDb: any;

    beforeEach(() => {
        mockDb = {};
        vi.spyOn(dbRepo, "getEntriesForContract").mockReturnValue([]);
        vi.spyOn(dbRepo, "upsertEntry").mockImplementation(() => {});
        vi.spyOn(dbRepo, "getAllContracts").mockReturnValue([
            { id: "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6", network: "testnet" }
        ] as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("discoverStorageKeys", () => {
        const validContractId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

        it("fails gracefully if network is unknown", async () => {
            const result = await discoverStorageKeys(mockDb, validContractId, "unknown");
            expect(result.error).toContain("Unknown network");
        });

        it("fails gracefully if RPC is offline or returns no latestLedger", async () => {
            const result = await discoverStorageKeys(mockDb, validContractId, "testnet", "https://offline");
            expect(result.error).toContain("Could not determine latest ledger");
        });

        it("returns early if no events are found", async () => {
            const result = await discoverStorageKeys(mockDb, validContractId, "testnet", "https://no-events");
            expect(result.transactionsScanned).toBe(0);
            expect(result.newKeysDiscovered).toBe(0);
        });

        it("discovers new keys from footprints and upserts them", async () => {
            const result = await discoverStorageKeys(mockDb, validContractId, "testnet", "https://good");
            
            // 3 hashes total, but hash2 is duplicate. So 2 unique transactions (hash1, hash3). Wait, actually we process by txHash, so 2 transactions.
            // Wait! The mock `events` has hash1, hash2, hash3. We should de-duplicate txHashes.
            // 3 unique txHashes! hash1, hash2, hash3.
            // Each tx gives 2 keys for the target contract and 1 key for another contract.
            // The other contract key is ignored.
            // So 3 transactions * 2 keys = 6 keys.
            expect(result.transactionsScanned).toBe(3); // 3 unique transactions
            expect(result.newKeysDiscovered).toBe(6);
            expect(dbRepo.upsertEntry).toHaveBeenCalledTimes(6);
        });

        it("handles missing envelopeXdr gracefully", async () => {
            const result = await discoverStorageKeys(mockDb, validContractId, "testnet", "https://missing-entries");
            expect(result.transactionsScanned).toBe(3);
            expect(result.newKeysDiscovered).toBe(0);
        });
    });

    describe("runBatchDiscovery", () => {
        it("scans all contracts for a network", async () => {
            const result = await runBatchDiscovery(mockDb, "testnet", "https://good");
            
            expect(result.contractsScanned).toBe(1);
            expect(result.totalNewKeys).toBe(6); // From the one contract
            expect(result.results).toHaveLength(1);
            expect(result.errors).toHaveLength(0);
        });
    });
});
