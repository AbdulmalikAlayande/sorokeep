import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { Keypair } from '@stellar/stellar-sdk';
const DUMMY_SECRET = Keypair.random().secret();

describe('Budget Enforcement', () => {
    let db: Database.Database;

    beforeEach(() => {
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
});
