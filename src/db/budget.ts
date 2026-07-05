import type Database from "better-sqlite3";

export interface Budget {
    id: number;
    contract_id: string;
    billing_cycle: string;
    limit_xlm: number;
    spent_xlm: number;
}

export function upsertBudget(db: Database.Database, budget: {
    contract_id: string;
    billing_cycle: string;
    limit_xlm: number;
    spent_xlm?: number;
}): void {
    if (budget.spent_xlm !== undefined) {
        db.prepare(`
            INSERT INTO budgets (contract_id, billing_cycle, limit_xlm, spent_xlm)
            VALUES (@contract_id, @billing_cycle, @limit_xlm, @spent_xlm)
            ON CONFLICT(contract_id, billing_cycle) DO UPDATE SET
                limit_xlm = @limit_xlm,
                spent_xlm = @spent_xlm
        `).run(budget);
    } else {
        db.prepare(`
            INSERT INTO budgets (contract_id, billing_cycle, limit_xlm, spent_xlm)
            VALUES (@contract_id, @billing_cycle, @limit_xlm, 0)
            ON CONFLICT(contract_id, billing_cycle) DO UPDATE SET
                limit_xlm = @limit_xlm
        `).run(budget);
    }
}

export function getBudget(db: Database.Database, contractId: string, billingCycle: string): Budget | undefined {
    return db.prepare("SELECT * FROM budgets WHERE contract_id = ? AND billing_cycle = ?")
        .get(contractId, billingCycle) as Budget | undefined;
}

export function addBudgetSpent(db: Database.Database, contractId: string, billingCycle: string, amountXlm: number): void {
    db.prepare(`
        UPDATE budgets
        SET spent_xlm = spent_xlm + ?
        WHERE contract_id = ? AND billing_cycle = ?
    `).run(amountXlm, contractId, billingCycle);
}
