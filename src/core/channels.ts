import type Database from "better-sqlite3";
import { StellarRpcClient } from "../rpc/client.js";
import {
    insertChannelAccount,
    getChannelAccounts,
    markChannelFunded,
    type ChannelAccount,
} from "../db/repositories.js";

export interface FundChannelsResult {
    funded: number;
    txHash: string;
    errors: string[];
}

export function addChannel(
    db: Database.Database,
    publicKey: string,
    network: string,
    label?: string,
): void {
    insertChannelAccount(db, { public_key: publicKey, network, label });
}

export function listChannels(db: Database.Database, network: string): ChannelAccount[] {
    return getChannelAccounts(db, network);
}

export async function fundChannels(
    db: Database.Database,
    masterSecretKey: string,
    amountXlm: string,
    network: string,
    rpcUrl?: string,
): Promise<FundChannelsResult> {
    const accounts = getChannelAccounts(db, network);
    if (accounts.length === 0) {
        return { funded: 0, txHash: "", errors: [] };
    }

    const client = new StellarRpcClient(network, rpcUrl);
    const destinations = accounts.map((a) => ({
        publicKey: a.public_key,
        amountXlm,
    }));

    const result = await client.sendPayments(destinations, masterSecretKey);

    if (!result.success) {
        return { funded: 0, txHash: result.txHash, errors: [result.error ?? "Transaction failed"] };
    }

    for (const account of accounts) {
        markChannelFunded(db, account.public_key);
    }

    return { funded: accounts.length, txHash: result.txHash, errors: [] };
}
