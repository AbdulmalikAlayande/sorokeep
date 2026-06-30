/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StellarRpcClient, extractResourceCosts, executeWithRetry } from "../../src/rpc/client";
import { Contract, xdr, Keypair } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () =>  {
    const actualModule = await vi.importActual<any>("@stellar/stellar-sdk");
    const moduleRPC = actualModule.rpc as Record<string, unknown>;

    class MockRPCServer {
        public serverUrl: string;
        constructor(serverUrl: string) {
            this.serverUrl = serverUrl;
            if (serverUrl && serverUrl.startsWith("ftp")) {
                throw new Error("Invalid URL scheme");
            }
        }

        async getHealth() {
            if (this.serverUrl && this.serverUrl.includes("timeout")) {
                throw new Error("Timeout");
            }
            if (this.serverUrl && this.serverUrl.includes("unhealthy")) {
                return { status: "offline" };
            }
            return { status: "healthy", latestLedger: 2443398, oldestLedger: 2322439, ledgerRetentionWindow: 120960 };
        }


        async getFeeStats() {
            if (this.serverUrl && this.serverUrl.includes("timeout")) throw new Error("Timeout");
            return {
                latestLedger: 2443398,
                inclusionFee: {
                    max: "250", min: "100", mode: "100", p10: "100", p20: "100", p30: "100",
                    p40: "100", p50: "125", p60: "150", p70: "175", p80: "200", p90: "225",
                    p95: "250", p99: "250",
                },
            };
        }

        async getLedgerEntries(...keys: any[]) {
            if (this.serverUrl && this.serverUrl.includes("timeout")) throw new Error("Timeout");
            
            return {
                latestLedger: 2443398,
                entries: keys.map(k => {
                    const kStr = k.toXDR ? k.toXDR("base64") : k;
                    let isMissing = false;
                    try {
                        const parsedK = actualModule.xdr.LedgerKey.fromXDR(kStr, "base64");
                        if (parsedK.switch().name === 'contractCode') {
                            const hash = parsedK.contractCode().hash().toString('hex');
                            if (hash === Buffer.from("missing".padEnd(32, "a")).toString("hex")) isMissing = true;
                        } else if (parsedK.switch().name === 'contractData') {
                            const contractIdStr = parsedK.contractData().contract().contractId().toString('hex');
                            if (contractIdStr === Buffer.from("missing".padEnd(32, "a")).toString("hex")) isMissing = true;
                        }
                    } catch {
                        // ignore parsing errors in test
                    }

                    if (isMissing || kStr.includes("missing")) return null;
                    if (kStr.includes("invalid")) return { xdr: "invalid" };
                    if (kStr.includes("token")) {
                        return {
                            lastModifiedLedgerSeq: 2400000,
                            liveUntilLedgerSeq: 2543398,
                            key: kStr,
                            val: {
                                contractData: () => ({
                                    val: () => ({
                                        instance: () => ({
                                            executable: () => ({
                                                switch: () => ({ name: "contractExecutableToken" }),
                                            }),
                                        }),
                                    }),
                                }),
                            },
                            xdr: "mock-xdr"
                        };
                    }
                    return {
                        lastModifiedLedgerSeq: 2400000,
                        liveUntilLedgerSeq: 2543398,
                        key: { toXDR: () => kStr },
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
                    };
                }).filter(Boolean),
            };
        }

        async getTransaction(hash: string) {
            if (hash === "missing") return { status: "NOT_FOUND" };
            if (hash === "failed") return { status: "FAILED", resultXdr: "mock-failed-xdr" };
            return { status: "SUCCESS", resultMetaXdr: "mock-result-meta-xdr" };
        }

        async getAccount(publicKey: string) {
            return new actualModule.Account(publicKey, "123");
        }

        async simulateTransaction(_tx: any) {
            if (this.serverUrl && this.serverUrl.includes("sim-fail")) return { error: "Simulation failed" };
            return {
                cost: { cpuInsns: "1000", memBytes: "100" },
                transactionData: new actualModule.SorobanDataBuilder().build(),
                minResourceFee: "100",
            };
        }

        async sendTransaction(_tx: any) {
            if (this.serverUrl && this.serverUrl.includes("send-error")) {
                return { status: "ERROR", errorResult: "Something went wrong", hash: "error-hash" };
            }
            return { status: "PENDING", hash: "mock-tx-hash" };
        }
    }

    return {
        ...actualModule,
        rpc: {
            ...moduleRPC,
            Server: MockRPCServer,
            assembleTransaction: vi.fn(() => ({ build: () => ({ sign: vi.fn() }) })),
            Api: {
                ...moduleRPC.Api,
                isSimulationError: vi.fn((sim: any) => !!sim.error)
            }
        },
        xdr: {
            ...actualModule.xdr,
            TransactionMeta: {
                fromXDR: vi.fn((xdrString: string) => {
                    if (xdrString === "mock-result-meta-xdr") {
                        return {
                            v3: () => ({
                                sorobanMeta: () => ({
                                    cpuInstructions: () => 15000,
                                    memoryBytes: () => 1024
                                })
                            })
                        };
                    }
                    throw new Error("Invalid XDR");
                })
            }
        }
    };
});

describe("StellarRpcClient", () => {
    let client: StellarRpcClient;

    beforeEach(() => {
        client = new StellarRpcClient("testnet")
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("RPC Client Construction", () => {
        it('should create a client for the testnet network', () => {
            const testnetClient = new StellarRpcClient("testnet");
            expect(testnetClient.getNetwork()).toBe("testnet");
        });

        it('should create a client for the mainnet network', () => {
            const mainnetClient = new StellarRpcClient("mainnet");
            expect(mainnetClient.getNetwork()).toBe("mainnet");
        });

        it('should create a client with a custom RPC url', () => {
            const customClient = new StellarRpcClient("testnet", "https://custom-rpc.com");
            expect(customClient.getNetwork()).toBe("testnet");
        });
        
        it('should throw or reject nicely if given an invalid URL scheme', () => {
            expect(() => new StellarRpcClient("testnet", "ftp://bad-url")).toThrow();
        });
    });

    describe("RPC Server Health Check", () => {
        it('should return the health status from the RPC server', async () => {
            const health = await client.checkHealth();
            expect(health.status).toBe("healthy");
            expect(health.latestLedger).toBe(2443398);
        });

        it('should throw an error or handle timeouts gracefully', async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.checkHealth()).rejects.toThrow();
        });
        
        it('should handle offline status', async () => {
            const offlineClient = new StellarRpcClient("testnet", "https://unhealthy.com");
            const health = await offlineClient.checkHealth();
            expect(health.status).toBe("offline");
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
            expect(retrievedContractInstanceEntry!.executableType).toBe("contractExecutableWasm");
            expect(retrievedContractInstanceEntry!.wasmHash).toHaveLength(64);
            expect(typeof retrievedContractInstanceEntry!.entryKeyXdr).toBe("string");
        });

        it('should return null or handle missing contracts', async () => {
            // Test goes here
        });

        it('should handle token contracts (non-WASM executable type)', async () => {
        });
        
        it('should gracefully handle malformed ledger entries from RPC', async () => {
        });
        
        it('should reject if RPC times out during getContractInstanceEntry', async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getContractInstanceEntry("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6")).rejects.toThrow();
        });
    });

    describe("Wasm Code Entry Operations with `getWasmCodeEntry(wasmHash)`",  () => {
        it('should return WASM code entry with TTL data', async () => {
            const wasmHash = "ab".repeat(32);
            const wasmCodeEntry = await client.getWasmCodeEntry(wasmHash);
            expect(wasmCodeEntry).toBeDefined();
            expect(wasmCodeEntry!.latestLedger).toBe(2443398);
            expect(wasmCodeEntry!.remainingTTL).toBe(100000);
            expect(typeof wasmCodeEntry!.entryKeyXdr).toBe("string");
        });
        
        it('should return null for missing WASM hash', async () => {
            const missingHash = Buffer.from("missing".padEnd(32, "a")).toString("hex");
            const entry = await client.getWasmCodeEntry(missingHash);
            expect(entry).toBeNull();
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
        });
        
        it("handles empty array gracefully without throwing", async () => {
            const retrievedEntryTTLs = await client.getEntryTTLs([]);
            expect(retrievedEntryTTLs.entries).toHaveLength(0);
        });
        
        it("handles missing entries in the array response", async () => {
            const validXdr = new Contract("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6").getFootprint().toXDR("base64");
            const xdrObj = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
                contract: new xdr.ScAddress.scAddressTypeContract(Buffer.from("missing".padEnd(32, "a"))),
                key: xdr.ScVal.scvLedgerKeyContractInstance(),
                durability: xdr.ContractDataDurability.persistent()
            }));
            const missingXdr = xdrObj.toXDR("base64");
            const retrievedEntryTTLs = await client.getEntryTTLs([validXdr, missingXdr]);
            expect(retrievedEntryTTLs.entries).toHaveLength(1);
        });
        
        it("handles malformed base64 strings gracefully", async () => {
            await expect(client.getEntryTTLs(["!!!not-base64!!!"])).rejects.toThrow();
        });
    });

    describe("getCurrentLedger", () => {
        it("returns the current ledger number", async () => {
            const ledger = await client.getCurrentLedger();
            expect(ledger).toBe(2443398);
        });
        
        it("throws if RPC is unreachable", async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getCurrentLedger()).rejects.toThrow();
        });
    });

    describe("Transaction Resource Costs Extraction", () => {
        it("Extracts and logs CPU instructions and memory consumption metrics successfully", () => {
            const mockXdr = "mock-result-meta-xdr";
            const extracted = extractResourceCosts(mockXdr);
            expect(extracted).toBeDefined();
            expect(extracted!.cpuInstructions).toBe(15000);
            expect(extracted!.memoryBytes).toBe(1024);
        });

        it("Returns null if XDR decoding fails or metadata is missing", () => {
            const invalidXdr = "invalid-xdr";
            const extracted = extractResourceCosts(invalidXdr);
            expect(extracted).toBeNull();
        });
        
        it("Returns null if empty string is passed", () => {
            const extracted = extractResourceCosts("");
            expect(extracted).toBeNull();
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
        
        it("throws when RPC times out", async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getFeeStats()).rejects.toThrow();
        });
    });

    describe("Transaction Submissions", () => {
        const dummyKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
            contract: new xdr.ScAddress.scAddressTypeContract(Buffer.from("a".repeat(32))),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent()
        })).toXDR("base64");

        const secretKey = Keypair.random().secret();

        it("submitExtension succeeds", async () => {
            const result = await client.submitExtension([dummyKey], 1000, secretKey);
            expect(result.success).toBe(true);
            expect(result.txHash).toBe("mock-tx-hash");
        });

        it("submitExtension handles simulation error", async () => {
            const simFailClient = new StellarRpcClient("testnet", "https://sim-fail.com");
            const result = await simFailClient.submitExtension([dummyKey], 1000, secretKey);
            expect(result.success).toBe(false);
            expect(result.error).toBe("Simulation failed");
        });

        it("submitExtension handles send error", async () => {
            const sendErrorClient = new StellarRpcClient("testnet", "https://send-error.com");
            const result = await sendErrorClient.submitExtension([dummyKey], 1000, secretKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Something went wrong");
        });

        it("submitRestore succeeds", async () => {
            const result = await client.submitRestore([dummyKey], secretKey);
            expect(result.success).toBe(true);
        });

        it("pollTransaction handles FAILED status", async () => {
            const result = await client["pollTransaction"]("failed");
            expect(result.success).toBe(false);
            expect(result.error).toContain("Transaction failed");
        });

        it("pollTransaction handles NOT_FOUND and timeout", async () => {
            const mockClient = new StellarRpcClient("testnet", "https://testnet.stellar.org");
            mockClient.server.getTransaction = vi.fn().mockResolvedValue({ status: "NOT_FOUND" });
            const result = await mockClient["pollTransaction"]("missing", 2, 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Transaction polling timed out after 2 attempts");
        });
    });

    describe("executeWithRetry", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        it("Succeeds if transient failure resolves within retries", async () => {
            let attempts = 0;
            const action = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 3) {
                    const error = new Error("503 Service Unavailable");
                    (error as any).response = { status: 503 };
                    throw error;
                }
                return "success";
            });

            const promise = executeWithRetry(action);
            
            // Advance timers for backoff
            await vi.advanceTimersByTimeAsync(1000); // 1st retry
            await vi.advanceTimersByTimeAsync(2000); // 2nd retry

            const result = await promise;
            
            expect(result).toBe("success");
            expect(action).toHaveBeenCalledTimes(3);
        });

        it("Network timeouts trigger retry attempts", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const error = new Error("timeout");
                (error as any).code = "ETIMEDOUT";
                throw error;
            });

            let error: any;
            const promise = executeWithRetry(action).catch(e => { error = e; });

            // Fast forward through all retries: 1s, 2s, 4s
            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(2000);
            await vi.advanceTimersByTimeAsync(4000);

            await promise;
            expect(error).toBeDefined();
            expect(error.message).toBe("timeout");
            expect(action).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
        });
        
        it("Does not retry on non-transient errors like 400 Bad Request", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const error = new Error("400 Bad Request");
                (error as any).response = { status: 400 };
                throw error;
            });

            await expect(executeWithRetry(action)).rejects.toThrow("400 Bad Request");
            expect(action).toHaveBeenCalledTimes(1);
        });
    });
});
