import {Contract, rpc, xdr} from "@stellar/stellar-sdk";
import {getLogger} from "../logging";


const logger = getLogger().child({ component: 'StellarRpcClient' });

const RPC_URLS: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://mainnet.sorobanrpc.com",
};

export interface RpcHealthResult {
    status: string;
    latestLedger: number;
    oldestLedger: number;
    ledgerRetentionWindow: number;
}

export interface ContractInstanceResult {
    entryKeyXdr: string;
    latestLedger: number;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
    remainingTTL: number;
    executableType: string;
    wasmHash: string | null;
}

export interface LedgerEntryResult {
    entryKeyXdr: string;
    latestLedger: number;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
    remainingTTL: number;
}

export interface EntryTTLsResult {
    latestLedger: number;
    entries: Array<{
        entryKeyXdr: string;
        liveUntilLedgerSeq: number;
        lastModifiedLedgerSeq: number;
        remainingTTL: number;
    }>;
}

export class StellarRpcClient {

    private readonly network: string;
    private readonly server: rpc.Server;

    constructor(network: string, customUrl?: string) {
        this.network = network;
        const url = customUrl ?? RPC_URLS[network];
        if (!url) {
            throw new Error(`Unknown network "${network}". Use "testnet", "mainnet", or provide a custom URL.`);
        }
        this.server = new rpc.Server(url);
    }

    getNetwork(): string {
        return this.network;
    }

    async checkHealth(): Promise<RpcHealthResult> {
        const health = await this.server.getHealth();
        return {
            status: health.status,
            latestLedger: health.latestLedger,
            oldestLedger: health.oldestLedger,
            ledgerRetentionWindow: health.ledgerRetentionWindow,
        }
    }

    async getCurrentLedger(): Promise<number> {
        const health = await this.server.getHealth();
        return health.latestLedger;
    }

    async getContractInstanceEntry(contractId: string): Promise<ContractInstanceResult | null> {
        const contract = new Contract(contractId);
        const instanceKey = contract.getFootprint();
        const entryKeyXdr = instanceKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(instanceKey);

        if(!response.entries || response.entries.length === 0) return null;

        const entry = response.entries[0]!;
        const latestLedger = response.latestLedger;
        const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
        const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;
        const remainingTTL = liveUntilLedgerSeq - latestLedger;

        let executableType = "unknown";
        let wasmHash: string | null = null;
        
        try {
            const contractData = entry.val.contractData();
            const instance = contractData.val().instance();
            const executable = instance.executable();
            if (executable.switch().name === "contractExecutableWasm") {
                executableType = "contractExecutableWasm";
                wasmHash = executable.wasmHash().toString("hex");
            }
        }catch (e) {
            logger.error("Error extracting wasm hash from contract instance entry", e);
        }

        return {
            entryKeyXdr,
            executableType,
            latestLedger,
            liveUntilLedgerSeq,
            lastModifiedLedgerSeq,
            remainingTTL,
            wasmHash,
        }
    }

    async getWasmCodeEntry(wasmHashHex: string): Promise<LedgerEntryResult | null> {
        const wasmHash = Buffer.from(wasmHashHex, "hex");
        const wasmKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash: wasmHash}));
        const entryKeyXdr = wasmKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(wasmKey);
        if(!response.entries || response.entries.length === 0) return null;

        const entry = response.entries[0]!;
        const latestLedger = response.latestLedger;
        const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
        const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;

        return {
            entryKeyXdr,
            latestLedger,
            liveUntilLedgerSeq,
            lastModifiedLedgerSeq,
            remainingTTL: liveUntilLedgerSeq - latestLedger,
        }
    }
    async getEntryTTLs(entryKeyXdrs: string[]): Promise<EntryTTLsResult> {
        const keys = entryKeyXdrs.map((xdrStr) =>
            xdr.LedgerKey.fromXDR(xdrStr, "base64")
        );

        const response = await this.server.getLedgerEntries(...keys);
        const latestLedger = response.latestLedger;

        const entries = (response.entries ?? []).map((entry) => {
            const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
            const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;
            return {
                entryKeyXdr: entry.key.toXDR("base64"),
                liveUntilLedgerSeq,
                lastModifiedLedgerSeq,
                remainingTTL: liveUntilLedgerSeq - latestLedger,
            }
        });
        return { latestLedger, entries,}
    }
}