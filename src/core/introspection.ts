/* eslint-disable @typescript-eslint/no-unused-vars */
import type Database from "better-sqlite3";

export interface IntrospectionResult {
    contractsChecked: number;
    newEntriesFound: number;
    errors: string[];
}

export async function runIntrospectionRescan(
    _db: Database.Database,
    _network: string,
    _rpcUrl: string | undefined,
): Promise<IntrospectionResult> {
    return {
        contractsChecked: 0,
        newEntriesFound: 0,
        errors: [],
    };
}
