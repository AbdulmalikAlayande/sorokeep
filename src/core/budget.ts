import Database from "better-sqlite3";
import { getContractCostSummary } from "../db/repositories.js";

export interface SpendProgress {
    limit: number;
    spend: number;
    percentage: number;
}

export function setContractBudget(db: Database.Database, contractId: string, limit: number): void {
    db.prepare(`
        INSERT INTO contract_budgets (contract_id, monthly_limit_xlm, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(contract_id) DO UPDATE SET
            monthly_limit_xlm = excluded.monthly_limit_xlm,
            updated_at = CURRENT_TIMESTAMP
    `).run(contractId, limit);
}

export function getContractBudget(db: Database.Database, contractId: string): number | null {
    const row = db.prepare(`
        SELECT monthly_limit_xlm FROM contract_budgets WHERE contract_id = ?
    `).get(contractId) as { monthly_limit_xlm: number } | undefined;

    return row ? row.monthly_limit_xlm : null;
}

export function getMonthlySpendProgress(db: Database.Database, contractId: string): SpendProgress | null {
    const limit = getContractBudget(db, contractId);
    if (limit === null) return null;

    // Use past 30 days as a proxy for monthly spend
    const summary = getContractCostSummary(db, contractId, 30);
    const spend = summary.total_cost_xlm;
    const percentage = limit > 0 ? (spend / limit) * 100 : 0;

    return {
        limit,
        spend,
        percentage
    };
}
