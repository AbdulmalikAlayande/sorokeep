import {
    Contract,
    rpc,
    xdr,
    TransactionBuilder,
    Networks,
    Account,
    Operation,
    Keypair,
} from "@stellar/stellar-sdk";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "StellarRpcClient" });

const RPC_URLS: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://mainnet.sorobanrpc.com",
};

// Sorokeep's own processed types — intentionally NOT extending the SDK's LedgerEntryResult
// because we don't want to carry raw XDR objects (key, val) through the application layer.

export interface SorokeepLedgerEntryResult {
    entryKeyXdr: string;
    latestLedger: number;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
    remainingTTL: number;
}

export interface ContractInstanceResult extends SorokeepLedgerEntryResult {
    executableType: string;
    wasmHash: string | null;
}

export interface EntryTTLsResult {
    latestLedger: number;
    entries: SorokeepLedgerEntryResult[];
}

export interface SimulateExtensionResult {
    /** Estimated fee in stroops. */
    minResourceFee: number;
    /** Whether the simulation succeeded. */
    success: boolean;
    /** Error message if simulation failed. */
    error?: string;
}

export interface FeeStatsResult {
    latestLedger?: number;
    baseFeeStroops: number;
    surgeFeeStroops: number;
    surgePricingMultiplier: number;
}

export interface SubmitTransactionResult {
    /** Whether the transaction succeeded. */
    success: boolean;
    /** Transaction hash. */
    txHash: string;
    /** Ledger the transaction was included in. */
    ledger: number;
    /** Error message if the transaction failed. */
    error?: string;
}

const NETWORK_PASSPHRASES: Record<string, string> = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
};

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

    async getFeeStats(): Promise<FeeStatsResult> {
        const serverAny = this.server as any;
        if (typeof serverAny.getFeeStats !== "function") {
            throw new Error("RPC server does not support getFeeStats");
        }

        const response = await serverAny.getFeeStats();
        const inclusionFee = response.sorobanInclusionFee ?? response.inclusionFee;
        if (!inclusionFee) {
            throw new Error("RPC fee stats response did not include inclusion fee data");
        }

        const baseFeeStroops = parseFeeStat(inclusionFee.p50 ?? inclusionFee.mode ?? inclusionFee.min);
        const surgeFeeStroops = parseFeeStat(
            inclusionFee.p95 ?? inclusionFee.p90 ?? inclusionFee.max ?? baseFeeStroops,
        );
        const surgePricingMultiplier = baseFeeStroops > 0
            ? Math.max(surgeFeeStroops / baseFeeStroops, 1)
            : 1;

        return {
            latestLedger: typeof response.latestLedger === "number" ? response.latestLedger : undefined,
            baseFeeStroops,
            surgeFeeStroops,
            surgePricingMultiplier,
        };
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
    ): Promise<SorokeepLedgerEntryResult | null> {
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

    /**
     * Simulate an ExtendFootprintTTLOp to estimate fees before submitting.
     */
    async simulateExtension(
        entryKeyXdrs: string[],
        extendToLedgers: number,
        sourcePublicKey: string,
    ): Promise<SimulateExtensionResult> {
        const passphrase = await this.getNetworkPassphrase();

        // Fetch account to get a valid sequence number for simulation
        const accountResponse = await this.server.getAccount(sourcePublicKey);
        const account = new Account(sourcePublicKey, accountResponse.sequenceNumber());

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(
                Operation.extendFootprintTtl({
                    extendTo: extendToLedgers,
                }),
            )
            .setTimeout(30)
            .setSorobanData(
                new (rpc as any).SorobanDataBuilder()
                    .setReadOnly(keys)
                    .build(),
            )
            .build();

        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                minResourceFee: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
        return {
            success: true,
            minResourceFee: Number(successSim.minResourceFee ?? 0),
        };
    }

    /**
     * Build, sign, and submit an ExtendFootprintTTLOp transaction.
     * Uses simulation to prepare the transaction with correct resource parameters.
     */
    async submitExtension(
        entryKeyXdrs: string[],
        extendToLedgers: number,
        secretKey: string,
    ): Promise<SubmitTransactionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const publicKey = keypair.publicKey();

        // Fetch account sequence number
        const accountResponse = await this.server.getAccount(publicKey);
        const account = new Account(publicKey, accountResponse.sequenceNumber());

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(
                Operation.extendFootprintTtl({
                    extendTo: extendToLedgers,
                }),
            )
            .setTimeout(30)
            .setSorobanData(
                new (rpc as any).SorobanDataBuilder()
                    .setReadOnly(keys)
                    .build(),
            )
            .build();

        // Simulate to prepare the transaction
        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                txHash: "",
                ledger: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        // Assemble the transaction with simulation results
        const prepared = rpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);

        // Submit and poll for result
        const sendResult = await this.server.sendTransaction(prepared);

        if (sendResult.status === "ERROR") {
            const diagnostics = (sendResult as any).errorResult
                ?? (sendResult as any).diagnosticEventsXdr
                ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        // Poll for completion
        const txResult = await this.pollTransaction(sendResult.hash);
        return txResult;
    }

    /**
     * Build, sign, and submit a RestoreFootprintOp transaction to restore archived entries.
     */
    async submitRestore(
        entryKeyXdrs: string[],
        secretKey: string,
    ): Promise<SubmitTransactionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const publicKey = keypair.publicKey();

        const accountResponse = await this.server.getAccount(publicKey);
        const account = new Account(publicKey, accountResponse.sequenceNumber());

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(
                Operation.restoreFootprint({}),
            )
            .setTimeout(30)
            .setSorobanData(
                new (rpc as any).SorobanDataBuilder()
                    .setReadWrite(keys)
                    .build(),
            )
            .build();

        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                txHash: "",
                ledger: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        const prepared = rpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);

        const sendResult = await this.server.sendTransaction(prepared);

        if (sendResult.status === "ERROR") {
            const diagnostics = (sendResult as any).errorResult
                ?? (sendResult as any).diagnosticEventsXdr
                ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        return this.pollTransaction(sendResult.hash);
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private _cachedPassphrase: string | undefined;

    private async getNetworkPassphrase(): Promise<string> {
        if (this._cachedPassphrase) return this._cachedPassphrase;

        // Try fetching from the RPC server first
        try {
            const networkInfo = await this.server.getNetwork();
            if (networkInfo.passphrase) {
                this._cachedPassphrase = networkInfo.passphrase;
                return networkInfo.passphrase;
            }
        } catch {
            // Fall through to hardcoded table
        }

        const passphrase = NETWORK_PASSPHRASES[this.network];
        if (!passphrase) {
            throw new Error(
                `No network passphrase for "${this.network}". Use "testnet" or "mainnet".`,
            );
        }
        this._cachedPassphrase = passphrase;
        return passphrase;
    }

    /**
     * Poll getTransaction until it reaches a terminal state (SUCCESS or FAILED).
     */
    private async pollTransaction(
        txHash: string,
        maxAttempts = 30,
        intervalMs = 1000,
    ): Promise<SubmitTransactionResult> {
        for (let i = 0; i < maxAttempts; i++) {
            const txResponse = await this.server.getTransaction(txHash);

            if (txResponse.status === "SUCCESS") {
                return {
                    success: true,
                    txHash,
                    ledger: (txResponse as any).ledger ?? txResponse.latestLedger,
                };
            }

            if (txResponse.status === "FAILED") {
                return {
                    success: false,
                    txHash,
                    ledger: (txResponse as any).ledger ?? txResponse.latestLedger,
                    error: "Transaction failed on-chain",
                };
            }

            // NOT_FOUND — still pending
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        return {
            success: false,
            txHash,
            ledger: 0,
            error: `Transaction polling timed out after ${maxAttempts} attempts`,
        };
    }
}

function parseFeeStat(value: string | number | bigint | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === "bigint") return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
