import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, upsertEntry } from "../../src/db/repositories.js";
import { invokeGetContractStatus } from "../../src/mcp/tools/get_contract_status.js";

const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

describe("get_contract_status MCP tool", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = getDatabaseForTesting();
    });

    it("returns correct JSON representation of contract TTLs", async () => {
        insertContract(db, {
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });
        db.prepare("UPDATE contracts SET last_checked_ledger = ? WHERE id = ?").run(
            2_500_000,
            CONTRACT_ID,
        );
        upsertEntry(db, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "instance-key",
            entry_type: "instance",
            live_until_ledger: 2_505_000,
            discovery_source: "deterministic",
        });

        const result = await invokeGetContractStatus(db, CONTRACT_ID);

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({
            contractId: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
            lastCheckedLedger: 2_500_000,
            entries: [
                {
                    label: "Instance",
                    entryType: "instance",
                    entryKeyXdr: "instance-key",
                    liveUntilLedger: 2_505_000,
                    remainingTTL: 5_000,
                    approximateTimeRemaining: "~7h 38m",
                    status: "warning",
                },
            ],
        });
        expect(result.content[0]).toMatchObject({
            type: "text",
            text: JSON.stringify(result.structuredContent, null, 2),
        });
    });

    it("returns an MCP error when the contract is not registered", async () => {
        const result = await invokeGetContractStatus(db, CONTRACT_ID);

        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("not registered"),
        });
        expect(result.structuredContent).toBeUndefined();
    });
});
