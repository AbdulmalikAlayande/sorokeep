import type Database from "better-sqlite3";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "AlertDispatcher" });

export interface DeliveryResult {
    attempted: number;
    delivered: number;
    failed: number;
    errors: string[];
}

async function route(channelType: string, channelTarget: string, event: any): Promise<void> {}

export async function deliverPendingAlerts(db: Database.Database, network: string): Promise<DeliveryResult> {
    return { attempted: 0, delivered: 0, failed: 0, errors: [] };
}
