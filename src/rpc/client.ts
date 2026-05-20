import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { getLogger } from "../logging";

const logger = getLogger().child({ component: "StellarRpcClient" });

const RPC_URLS: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://mainnet.sorobanrpc.com",
};

// Sentinel's own processed types — intentionally NOT extending the SDK's LedgerEntryResult
// because we don't want to carry raw XDR objects (key, val) through the application layer.

export interface SentinelLedgerEntryResult {
    entryKeyXdr: string;
    latestLedger: number;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
    remainingTTL: number;
}

export interface ContractInstanceResult extends SentinelLedgerEntryResult {
    executableType: string;
    wasmHash: string | null;
}

export interface EntryTTLsResult {
    latestLedger: number;
    entries: SentinelLedgerEntryResult[];
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

    async checkHealth() {
        return await this.server.getHealth();
    }

    async getCurrentLedger(): Promise<number> {
        const serverAny = this.server as any;
        if (typeof serverAny.getLatestLedger === "function") {
            const response = await serverAny.getLatestLedger();
            if (response && typeof response.sequence === "number") return response.sequence;
        }

        const health = await this.server.getHealth();
        if (health && typeof (health as any).latestLedger === "number") {
            return (health as any).latestLedger;
        }

        throw new Error("Unable to determine latest ledger from RPC server");
    }

    async getContractInstanceEntry(contractId: string): Promise<ContractInstanceResult | null> {
        const contract = new Contract(contractId);
        const instanceKey = contract.getFootprint();
        const entryKeyXdr = instanceKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(instanceKey);

        if (!response.entries || response.entries.length === 0) return null;

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
            executableType = executable.switch().name;

            if (executableType === "contractExecutableWasm") {
                wasmHash = executable.wasmHash().toString("hex");
            }
        } catch (error) {
            logger.error("Error extracting executable info from contract instance entry", error);
        }

        return {
            entryKeyXdr,
            executableType,
            latestLedger,
            liveUntilLedgerSeq,
            lastModifiedLedgerSeq,
            remainingTTL,
            wasmHash,
        };
    }

    async getWasmCodeEntry(
        wasmHashHex: string
    ): Promise<SentinelLedgerEntryResult | null> {
        const wasmHash = Buffer.from(wasmHashHex, "hex");
        const wasmKey = xdr.LedgerKey.contractCode(
            new xdr.LedgerKeyContractCode({ hash: wasmHash })
        );
        const entryKeyXdr = wasmKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(wasmKey);
        if (!response.entries || response.entries.length === 0) return null;

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
        };
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
                latestLedger,
                liveUntilLedgerSeq,
                lastModifiedLedgerSeq,
                remainingTTL: liveUntilLedgerSeq - latestLedger,
            };
        });

        return { latestLedger, entries };
    }
}