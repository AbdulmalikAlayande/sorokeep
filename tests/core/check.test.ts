import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkContractTTL, CheckResult } from "../../src/core/check.js";

const mockGetContractInstanceEntry = vi.fn();
const mockGetWasmCodeEntry = vi.fn();

export const mockStellarRpcClientConstructor = vi.fn();
vi.mock('../../src/rpc/client.js', () => {
    return {
        StellarRpcClient: vi.fn().mockImplementation(function (this: any, ...args: any[]) {
            mockStellarRpcClientConstructor(...args);
            this.getContractInstanceEntry = mockGetContractInstanceEntry;
            this.getWasmCodeEntry = mockGetWasmCodeEntry;
        })
    };
});

const VALID_CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
const MOCK_LEDGER = 2_500_000;
const MOCK_WASM_HASH = "ab".repeat(32);

function mockInstance(remainingTTL: number, wasmHash: string | null = MOCK_WASM_HASH) {
    mockGetContractInstanceEntry.mockResolvedValue({
        entryKeyXdr: "instance-key-xdr",
        latestLedger: MOCK_LEDGER,
        liveUntilLedgerSeq: MOCK_LEDGER + remainingTTL,
        lastModifiedLedgerSeq: MOCK_LEDGER - 100,
        remainingTTL,
        executableType: wasmHash ? "contractExecutableWasm" : "contractExecutableStellarAsset",
        wasmHash,
    });
}

function mockWasm(remainingTTL: number) {
    mockGetWasmCodeEntry.mockResolvedValue({
        entryKeyXdr: "wasm-key-xdr",
        latestLedger: MOCK_LEDGER,
        liveUntilLedgerSeq: MOCK_LEDGER + remainingTTL,
        lastModifiedLedgerSeq: MOCK_LEDGER - 200,
        remainingTTL,
    });
}

describe("checkContractTTL", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. RETURN SHAPE
    // =========================================================================
    describe("Return shape", () => {
        it("returns all required fields", async () => {
            mockInstance(10000);
            mockWasm(15000);

            const result: CheckResult = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result).toHaveProperty("contractId");
            expect(result).toHaveProperty("network");
            expect(result).toHaveProperty("threshold");
            expect(result).toHaveProperty("latestLedger");
            expect(result).toHaveProperty("minimumTTL");
            expect(result).toHaveProperty("passed");
            expect(result).toHaveProperty("entries");
            expect(Array.isArray(result.entries)).toBe(true);
        });

        it("reflects the provided contractId, network and threshold in the result", async () => {
            mockInstance(5000, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "mainnet", 1000);

            expect(result.contractId).toBe(VALID_CONTRACT_ID);
            expect(result.network).toBe("mainnet");
            expect(result.threshold).toBe(1000);
        });

        it("passes rpcUrl to StellarRpcClient", async () => {
            mockInstance(5000, null);
            await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500, "https://custom.rpc");
            expect(mockStellarRpcClientConstructor).toHaveBeenCalledWith("testnet", "https://custom.rpc");
        });
    });

    // =========================================================================
    // 2. PASS / FAIL LOGIC
    // =========================================================================
    describe("Pass / fail logic", () => {
        it("passes when instance TTL is well above threshold", async () => {
            mockInstance(50000, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(true);
            expect(result.minimumTTL).toBe(50000);
        });

        it("fails when instance TTL is below threshold", async () => {
            mockInstance(100, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.minimumTTL).toBe(100);
        });

        it("passes when TTL exactly equals threshold (boundary: >= not >)", async () => {
            mockInstance(500, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(true);
        });

        it("fails when TTL is exactly one ledger below threshold", async () => {
            mockInstance(499, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
        });

        it("fails when TTL is expired (remainingTTL <= 0)", async () => {
            mockInstance(0, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
        });

        it("fails when TTL is negative (entry archived)", async () => {
            mockInstance(-500, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
        });
    });

    // =========================================================================
    // 3. MINIMUM TTL ACROSS INSTANCE AND WASM
    // =========================================================================
    describe("Minimum TTL across entries", () => {
        it("uses instance TTL when it is the minimum", async () => {
            mockInstance(1000);
            mockWasm(50000);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.minimumTTL).toBe(1000);
        });

        it("uses WASM TTL when it is the minimum", async () => {
            mockInstance(50000);
            mockWasm(200);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.minimumTTL).toBe(200);
        });

        it("fails when WASM TTL is below threshold even if instance TTL is above", async () => {
            mockInstance(10000);
            mockWasm(100);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.minimumTTL).toBe(100);
        });

        it("passes when both instance and WASM TTL are at or above threshold", async () => {
            mockInstance(5000);
            mockWasm(3000);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(true);
            expect(result.minimumTTL).toBe(3000);
        });

        it("populates entries array with both instance and WASM when both are present", async () => {
            mockInstance(5000);
            mockWasm(3000);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.entries).toHaveLength(2);
            const types = result.entries.map(e => e.entryType);
            expect(types).toContain("instance");
            expect(types).toContain("wasm");
        });

        it("populates entries array with only instance when contract has no WASM hash (SAC)", async () => {
            mockInstance(5000, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.entries).toHaveLength(1);
            expect(result.entries[0]!.entryType).toBe("instance");
        });

        it("fails closed when WASM entry is not found on RPC", async () => {
            mockInstance(5000);
            mockGetWasmCodeEntry.mockResolvedValue(null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.minimumTTL).toBe(0);
            expect(result.error).toMatch(/WASM code entry.*not found/);
        });
    });

    // =========================================================================
    // 4. ENTRY DATA
    // =========================================================================
    describe("Entry data correctness", () => {
        it("entry TTL values match what the RPC returned", async () => {
            mockInstance(8000);
            mockWasm(12000);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            const instance = result.entries.find(e => e.entryType === "instance")!;
            const wasm = result.entries.find(e => e.entryType === "wasm")!;

            expect(instance.remainingTTL).toBe(8000);
            expect(wasm.remainingTTL).toBe(12000);
        });

        it("latestLedger in result matches the value from the RPC instance response", async () => {
            mockInstance(5000, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.latestLedger).toBe(MOCK_LEDGER);
        });
    });

    // =========================================================================
    // 5. ERROR HANDLING
    // =========================================================================
    describe("Error handling", () => {
        it("returns passed=false with an error message when contract is not found on RPC", async () => {
            mockGetContractInstanceEntry.mockResolvedValue(null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.minimumTTL).toBe(0);
            expect(result.error).toBeDefined();
            expect(result.error).toMatch(/not found/i);
        });

        it("returns passed=false with error when RPC throws a network error", async () => {
            mockGetContractInstanceEntry.mockRejectedValue(new Error("Connection refused"));

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.error).toBe("Connection refused");
        });

        it("returns passed=false with error when RPC throws a timeout error", async () => {
            mockGetContractInstanceEntry.mockRejectedValue(new Error("Request timed out"));

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.passed).toBe(false);
            expect(result.error).toMatch(/timed out/i);
        });

        it("returns empty entries array on error", async () => {
            mockGetContractInstanceEntry.mockRejectedValue(new Error("Network down"));

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);

            expect(result.entries).toHaveLength(0);
        });

        it("does not throw — always returns a CheckResult even on unexpected errors", async () => {
            mockGetContractInstanceEntry.mockRejectedValue(new TypeError("Cannot read properties of undefined"));

            await expect(checkContractTTL(VALID_CONTRACT_ID, "testnet", 500)).resolves.toBeDefined();
        });
    });

    // =========================================================================
    // 6. THRESHOLD EDGE CASES
    // =========================================================================
    describe("Threshold edge cases", () => {
        it("handles threshold of 0 — always passes when TTL >= 0", async () => {
            mockInstance(1, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 0);

            expect(result.passed).toBe(true);
        });

        it("handles very large threshold — fails when TTL is below it", async () => {
            mockInstance(1000, null);

            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 1_000_000);

            expect(result.passed).toBe(false);
        });

        it("uses the provided rpcUrl when connecting to the network", async () => {
            mockInstance(5000, null);

            // Should not throw when a custom rpcUrl is provided
            const result = await checkContractTTL(
                VALID_CONTRACT_ID,
                "testnet",
                500,
                "https://custom-rpc.example.com",
            );

            expect(result.passed).toBe(true);
        });
    });
});
