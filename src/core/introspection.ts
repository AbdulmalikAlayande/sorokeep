import type Database from "better-sqlite3";

export interface IntrospectionResult {
    contractsChecked: number;
    newEntriesFound: number;
    errors: string[];
}

export async function runIntrospectionRescan(
    db: Database.Database,
    network: string,
    rpcUrl: string | undefined,
): Promise<IntrospectionResult> {
    return {
        contractsChecked: 0,
        newEntriesFound: 0,
        errors: [],
    };
}
