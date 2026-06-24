import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    getContract,
    getEntriesForContract,
} from "../../src/db/repositories.js";
import { watchContract } from "../../src/core/watch.js";

const mockGetContractInstanceEntry = vi.fn();
const mockGetWasmCodeEntry = vi.fn();
const mockGetEntryTTLs = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getContractInstanceEntry = mockGetContractInstanceEntry;
        getWasmCodeEntry = mockGetWasmCodeEntry;
        getEntryTTLs = mockGetEntryTTLs;
        checkHealth = vi.fn().mockResolvedValue({ status: "healthy", latestLedger: 2443398 });
        getNetwork = vi.fn().mockReturnValue("testnet");
    }
    return {
        StellarRpcClient: MockStellarRpcClient,
    };
});

describe("watchContract - Deep Coverage Suite", () => {
    let db: Database.Database;
    const VALID_CID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    const MOCK_LEDGER = 2443398;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
    });

    // --- 1. SUCCESS PATHS ---

    it("registers a standard WASM contract with full discovery (Instance and WASM)", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key-xdr",
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 10000,
            lastModifiedLedgerSeq: MOCK_LEDGER - 500,
            remainingTTL: 10000,
            executableType: "contractExecutableWasm",
            wasmHash: "ab".repeat(32),
        });

        mockGetWasmCodeEntry.mockResolvedValue({
            entryKeyXdr: "wasm-key-xdr",
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 50000,
            lastModifiedLedgerSeq: MOCK_LEDGER - 1000,
            remainingTTL: 50000,
        });

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            name: "Standard WASM Contract",
        });

        expect(result.success).toBe(true);
        expect(result.instance).toBeDefined();
        expect(result.instance!.remainingTTL).toBe(10000);
        expect(result.instance!.liveUntilLedgerSeq).toBe(MOCK_LEDGER + 10000);
        expect(result.wasm).toBeDefined();
        expect(result.wasm!.remainingTTL).toBe(50000);

        // Verifying Contract Record
        const contract = getContract(db, VALID_CID);
        expect(contract).toBeDefined();
        expect(contract!.wasm_hash).toBe("ab".repeat(32));
        expect(contract!.last_checked_ledger).toBe(MOCK_LEDGER);

        // Verifying Entries
        const entries = getEntriesForContract(db, VALID_CID);
        expect(entries).toHaveLength(2);
        expect(entries.find(e => e.entry_type === "instance")).toBeDefined();
        expect(entries.find(e => e.entry_type === "wasm")).toBeDefined();
    });

    it("registers a SAC (Stellar Asset Contract) and skips WASM discovery", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "sac-key-xdr",
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 10000,
            lastModifiedLedgerSeq: MOCK_LEDGER - 500,
            remainingTTL: 10000,
            executableType: "contractExecutableStellarAsset",
            wasmHash: null,
        });

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
        });

        expect(result.success).toBe(true);
        expect(mockGetWasmCodeEntry).not.toHaveBeenCalled();

        const entries = getEntriesForContract(db, VALID_CID);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.entry_type).toBe("instance");
    });

    // --- 2. EDGE CASES: ARCHIVAL & DISCOVERY ---

    it("handles archived WASM entry gracefully while registering instance", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key-xdr",
            wasmHash: "dead".repeat(16),
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 1000,
            remainingTTL: 1000,
        });

        // WASM is archived (not found on RPC)
        mockGetWasmCodeEntry.mockResolvedValue(null);

        const result = await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        expect(result.success).toBe(true);
        expect(result.wasm).toBeNull();
        expect(result.wasmWarning).toContain("not found");

        const entries = getEntriesForContract(db, VALID_CID);
        expect(entries).toHaveLength(1); // Only instance stored
    });

    it("supports discovery of manual storage keys during initial watch", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key-xdr",
            wasmHash: null,
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 1000,
            remainingTTL: 1000,
        });

        mockGetEntryTTLs.mockResolvedValue({
            latestLedger: MOCK_LEDGER,
            entries: [
                {
                    entryKeyXdr: "storage-key-1-xdr",
                    latestLedger: MOCK_LEDGER,
                    liveUntilLedgerSeq: MOCK_LEDGER + 5000,
                    lastModifiedLedgerSeq: MOCK_LEDGER - 100,
                    remainingTTL: 5000,
                }
            ]
        });

        const result = await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            storageKeys: ["storage-key-1-xdr"]
        });

        expect(result.success).toBe(true);
        const entries = getEntriesForContract(db, VALID_CID);
        expect(entries).toHaveLength(2); // Instance + 1 Storage Entry
        expect(entries.find(e => e.entry_type === "persistent" || e.entry_type === "temporary")).toBeDefined();
    });

    // --- 3. IDEMPOTENCY & UPDATES ---

    it("updates contract metadata and TTLs on re-watch without duplication", async () => {
        // 1st Watch
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key",
            latestLedger: 100,
            liveUntilLedgerSeq: 1000,
            remainingTTL: 900,
        });
        await watchContract(db, { contractId: VALID_CID, network: "testnet", name: "Old Name" });

        // 2nd Watch
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key",
            latestLedger: 200,
            liveUntilLedgerSeq: 1100,
            remainingTTL: 900,
        });
        const result = await watchContract(db, { contractId: VALID_CID, network: "testnet", name: "New Name" });

        expect(result.success).toBe(true);

        const contract = getContract(db, VALID_CID);
        expect(contract!.name).toBe("New Name");
        expect(contract!.last_checked_ledger).toBe(200);

        const entries = getEntriesForContract(db, VALID_CID);
        expect(entries).toHaveLength(1); // No duplicates
        expect(entries[0]!.live_until_ledger).toBe(1100);
    });

    // --- 4. ERROR HANDLING ---

    it("fails with meaningful error when contract ID is invalid", async () => {
        // Implementation should ideally validate CID format before network calls
        const result = await watchContract(db, {
            contractId: "INVALID-CID",
            network: "testnet",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid|format|address/i);
    });

    it("handles RPC network timeout/failure gracefully", async () => {
        mockGetContractInstanceEntry.mockRejectedValue(new Error("RPC Timeout"));

        const result = await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("RPC Timeout");

        // Database should be empty
        expect(getContract(db, VALID_CID)).toBeUndefined();
    });

    it("fails when the contract has expired or does not exist on-chain", async () => {
        mockGetContractInstanceEntry.mockResolvedValue(null);

        const result = await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
    });

    // --- 5. NETWORK SPECIFICITY ---

    it("rejects re-watch on a different network for the same contract ID", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key",
            latestLedger: 100,
            liveUntilLedgerSeq: 1000,
            remainingTTL: 900,
        });

        await watchContract(db, { contractId: VALID_CID, network: "testnet" });

        const result = await watchContract(db, { contractId: VALID_CID, network: "mainnet" });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/already registered|different network/i);

        // Original registration is unchanged
        const contract = getContract(db, VALID_CID);
        expect(contract!.network).toBe("testnet");
    });

    it("skips WASM discovery when noIntrospection is true", async () => {
        mockGetContractInstanceEntry.mockResolvedValue({
            entryKeyXdr: "instance-key-xdr",
            latestLedger: MOCK_LEDGER,
            liveUntilLedgerSeq: MOCK_LEDGER + 10000,
            lastModifiedLedgerSeq: MOCK_LEDGER - 500,
            remainingTTL: 10000,
            executableType: "contractExecutableWasm",
            wasmHash: "ab".repeat(32),
        });

        await watchContract(db, {
            contractId: VALID_CID,
            network: "testnet",
            noIntrospection: true,
        });

        expect(mockGetWasmCodeEntry).not.toHaveBeenCalled();
    });
});
