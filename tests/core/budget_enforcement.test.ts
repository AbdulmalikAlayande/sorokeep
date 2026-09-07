import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runAutoExtensions } from '../../src/core/extension';
import { 
    insertContract, 
    upsertExtensionPolicy, 
    upsertEntry, 
    upsertBudget, 
    getBudget 
} from '../../src/db/repositories';

// Mock dependencies
vi.mock('../../src/rpc/client', () => {
    return {
        StellarRpcClient: vi.fn().mockImplementation(() => ({
            getCurrentLedger: vi.fn().mockResolvedValue(1000),
            simulateExtension: vi.fn().mockResolvedValue({
                success: true,
                minResourceFee: 15000000 // 1.5 XLM in stroops
            }),
            submitExtension: vi.fn().mockResolvedValue({
                success: true,
                txHash: '0x123',
                ledger: 1001,
                cpuInsns: 100,
                memBytes: 100
            }),
            getEntryTTLs: vi.fn().mockResolvedValue({
                latestLedger: 1001,
                entries: [{
                    entryKeyXdr: 'AAAA',
                    remainingTTL: 50000,
                    liveUntilLedgerSeq: 51001,
                    lastModifiedLedgerSeq: 1001
                }]
            })
        }))
    };
});

// We need to mock resolveSecretKey indirectly if we want it to work without environment variables, but since it's an internal function in extension.ts we can just provide a raw secret key.
vi.mock("@stellar/stellar-sdk", () => {
    return {
        Keypair: {
            fromSecret: vi.fn().mockReturnValue({
                publicKey: vi.fn().mockReturnValue("GBDUMMYPUBLICKEYFORTESTING1234567890")
            })
        }
    };
});
// A genuinely checksum-valid Stellar secret key (not a real funded account).
// extension.ts resolves this via a *dynamic* `await import("@stellar/stellar-sdk")`
// inside runAutoExtensions, which does not reliably go through this file's
// `vi.mock("@stellar/stellar-sdk", ...)` in every environment (observed in CI:
// the real Keypair.fromSecret ran and threw "invalid checksum" on a
// deliberately-invalid placeholder, which silently turned a "both contracts
// blocked by the shared budget pool" assertion into a false failure for one
// of the two). Using a real, valid key removes the dependency on that mock
// being applied to make this test's core assertions correct.
const DUMMY_SECRET = 'SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7';

describe('Budget Enforcement', () => {
    let db: Database.Database;

    beforeEach(() => {
        // Freeze the clock so this suite's `new Date().toISOString().slice(0, 7)`
        // billing-cycle calls (both here and inside runAutoExtensions) always
        // agree, regardless of real wall-clock drift, month-boundary timing,
        // or CI worker scheduling. Without this, a test and the code under
        // test could compute different "current" billing cycles, silently
        // triggering the pool-rollover branch and invalidating assertions
        // that assume a stable, already-populated billing cycle.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

        db = new Database(':memory:');
        const schema = fs.readFileSync(path.resolve(__dirname, '../../src/db/schema.sql'), 'utf8');
        db.exec(schema);

        insertContract(db, { id: 'contract_1', network: 'testnet' });
        upsertExtensionPolicy(db, {
            contract_id: 'contract_1',
            enabled: true,
            target_ttl_ledgers: 50000,
            extend_when_below_ledgers: 20000,
            keypair_source: DUMMY_SECRET
        });
        upsertEntry(db, {
            contract_id: 'contract_1',
            entry_key_xdr: 'AAAA',
            entry_type: 'instance',
            live_until_ledger: 1500 // 500 remaining (1500 - 1000)
        });

        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('Extensions are skipped when budget limit is crossed', async () => {
        // Set limit to 1.0 XLM. Simulation costs 1.5 XLM.
        const currentCycle = new Date().toISOString().slice(0, 7);
        upsertBudget(db, {
            contract_id: 'contract_1',
            limit_xlm: 1.0,
            billing_cycle: currentCycle
        });

        const result = await runAutoExtensions(db, 'testnet');
        
        expect(result.contractsChecked).toBe(1);
        expect(result.contractsExtended).toBe(0);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('budget limit exceeded');
        
        const budget = getBudget(db, 'contract_1', currentCycle);
        expect(budget?.spent_xlm).toBe(0);
    });

    it('Database records spend history correctly when within budget', async () => {
        // Set limit to 2.0 XLM. Simulation costs 1.5 XLM.
        const currentCycle = new Date().toISOString().slice(0, 7);
        upsertBudget(db, {
            contract_id: 'contract_1',
            limit_xlm: 2.0,
            billing_cycle: currentCycle
        });

        const result = await runAutoExtensions(db, 'testnet');
        
        expect(result.contractsChecked).toBe(1);
        expect(result.contractsExtended).toBe(1);
        
        const budget = getBudget(db, 'contract_1', currentCycle);
        // spent_xlm should increase by 1.5
        expect(budget?.spent_xlm).toBe(1.5);
    });

    // ── Shared budget pools (#407) ─────────────────────────────────────────

    it('blocks every contract in a pool once their combined spend reaches the cap', async () => {
        insertContract(db, { id: 'contract_2', network: 'testnet' });
        upsertExtensionPolicy(db, { contract_id: 'contract_2', enabled: true, target_ttl_ledgers: 50000, extend_when_below_ledgers: 20000, keypair_source: DUMMY_SECRET });
        upsertEntry(db, { contract_id: 'contract_2', entry_key_xdr: 'BBBB', entry_type: 'instance', live_until_ledger: 1500 });
        const currentCycle = new Date().toISOString().slice(0, 7);
        const pool = db.prepare(`INSERT INTO shared_budget_pools (name, monthly_limit_xlm, billing_cycle, spent_xlm) VALUES (?, ?, ?, ?)`)
            .run('product-line', 100, currentCycle, 100);
        const assign = db.prepare(`INSERT INTO shared_budget_pool_contracts (pool_id, contract_id) VALUES (?, ?)`);
        assign.run(pool.lastInsertRowid, 'contract_1');
        assign.run(pool.lastInsertRowid, 'contract_2');
        upsertBudget(db, { contract_id: 'contract_1', limit_xlm: 1000, billing_cycle: currentCycle });
        upsertBudget(db, { contract_id: 'contract_2', limit_xlm: 1000, billing_cycle: currentCycle });

        const result = await runAutoExtensions(db, 'testnet');

        expect(result.contractsChecked).toBe(2);
        expect(result.contractsExtended).toBe(0);
        expect(result.errors).toHaveLength(2);
        expect(result.errors.every(error => error.includes('shared budget pool "product-line" limit exceeded'))).toBe(true);
        expect(getBudget(db, 'contract_1', currentCycle)?.spent_xlm).toBe(0);
        expect(getBudget(db, 'contract_2', currentCycle)?.spent_xlm).toBe(0);
    });

    it('records successful extension spend against the shared pool only', async () => {
        const currentCycle = new Date().toISOString().slice(0, 7);
        const pool = db.prepare(`INSERT INTO shared_budget_pools (name, monthly_limit_xlm, billing_cycle) VALUES (?, ?, ?)`)
            .run('product-line', 100, currentCycle);
        db.prepare(`INSERT INTO shared_budget_pool_contracts (pool_id, contract_id) VALUES (?, ?)`)
            .run(pool.lastInsertRowid, 'contract_1');
        upsertBudget(db, { contract_id: 'contract_1', limit_xlm: 1000, billing_cycle: currentCycle });

        const result = await runAutoExtensions(db, 'testnet');

        expect(result.contractsExtended).toBe(1);
        const sharedPool = db.prepare(`SELECT spent_xlm FROM shared_budget_pools WHERE id = ?`)
            .get(pool.lastInsertRowid) as { spent_xlm: number };
        expect(sharedPool.spent_xlm).toBe(1.5);
        expect(getBudget(db, 'contract_1', currentCycle)?.spent_xlm).toBe(0);
    });

    it('resets stale pool spend when a new billing cycle starts', async () => {
        const currentCycle = new Date().toISOString().slice(0, 7);
        const pool = db.prepare(`INSERT INTO shared_budget_pools (name, monthly_limit_xlm, billing_cycle, spent_xlm) VALUES (?, ?, ?, ?)`)
            .run('product-line', 2, '2000-01', 2);
        db.prepare(`INSERT INTO shared_budget_pool_contracts (pool_id, contract_id) VALUES (?, ?)`)
            .run(pool.lastInsertRowid, 'contract_1');

        const result = await runAutoExtensions(db, 'testnet');

        expect(result.contractsExtended).toBe(1);
        const sharedPool = db.prepare(`SELECT billing_cycle, spent_xlm FROM shared_budget_pools WHERE id = ?`)
            .get(pool.lastInsertRowid) as { billing_cycle: string; spent_xlm: number };
        expect(sharedPool).toEqual({ billing_cycle: currentCycle, spent_xlm: 1.5 });
    });
});
