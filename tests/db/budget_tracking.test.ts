import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { 
    insertContract, 
    upsertBudget, 
    getBudget, 
    addBudgetSpent 
} from '../../src/db/repositories.js';

describe('Budget Tracking DB', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        const schemaPath = path.resolve(__dirname, '../../src/db/schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        db.exec(schema);
        
        insertContract(db, { id: 'contract_1', network: 'testnet' });
    });

    afterEach(() => {
        db.close();
    });

    it('Migration or schema creation works without SQL syntax errors', () => {
        const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='budget_tracking'");
        const row = stmt.get();
        expect(row).toBeDefined();
    });

    it('Database tracking functions pass unit tests: upsert and get', () => {
        upsertBudget(db, {
            contract_id: 'contract_1',
            limit_xlm: 100.5,
            billing_cycle: '2026-06'
        });

        const budget = getBudget(db, 'contract_1', '2026-06');
        expect(budget).toBeDefined();
        expect(budget?.limit_xlm).toBe(100.5);
        expect(budget?.spent_xlm).toBe(0);
        expect(budget?.billing_cycle).toBe('2026-06');
        
        upsertBudget(db, {
            contract_id: 'contract_1',
            limit_xlm: 150,
            spent_xlm: 5,
            billing_cycle: '2026-06'
        });
        
        const updated = getBudget(db, 'contract_1', '2026-06');
        expect(updated?.limit_xlm).toBe(150);
        expect(updated?.spent_xlm).toBe(5);
    });

    it('Database tracking functions pass unit tests: addBudgetSpent', () => {
        upsertBudget(db, {
            contract_id: 'contract_1',
            limit_xlm: 100,
            billing_cycle: '2026-06'
        });
        
        addBudgetSpent(db, 'contract_1', '2026-06', 10.5);
        
        const budget = getBudget(db, 'contract_1', '2026-06');
        expect(budget?.spent_xlm).toBe(10.5);
        
        addBudgetSpent(db, 'contract_1', '2026-06', 5);
        const updated = getBudget(db, 'contract_1', '2026-06');
        expect(updated?.spent_xlm).toBe(15.5);
    });
});
