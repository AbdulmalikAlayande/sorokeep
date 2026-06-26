import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
    Contract,
    Keypair,
    StrKey,
    xdr,
} from "@stellar/stellar-sdk";

const SANDBOX_PASSPHRASE = "Sorokeep E2E Sandbox Network ; June 2026";

interface SandboxEntry {
    key: xdr.LedgerKey;
    val: xdr.LedgerEntryData;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
}

interface SubmittedTransaction {
    hash: string;
    ledger: number;
    envelopeXdr: string;
}

export interface SandboxDeployment {
    contractId: string;
    wasmHashHex: string;
    instanceKeyXdr: string;
    wasmKeyXdr: string;
}

export class InMemorySorobanSandbox {
    private server: Server | undefined;
    private entries = new Map<string, SandboxEntry>();
    private submittedTransactions = new Map<string, SubmittedTransaction>();

    latestLedger: number;
    rpcUrl = "";

    private constructor(initialLedger: number) {
        this.latestLedger = initialLedger;
    }

    static async start(options?: { initialLedger?: number }): Promise<InMemorySorobanSandbox> {
        const sandbox = new InMemorySorobanSandbox(options?.initialLedger ?? 1000);
        await sandbox.listen();
        return sandbox;
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve, reject) => {
            this.server!.close((err) => err ? reject(err) : resolve());
        });
        this.server = undefined;
    }

    deployTestContract(options?: { ttlLedgers?: number; contractSeedByte?: number }): SandboxDeployment {
        const ttlLedgers = options?.ttlLedgers ?? 6;
        const seed = options?.contractSeedByte ?? 1;
        const contractId = StrKey.encodeContract(Buffer.alloc(32, seed));
        const contract = new Contract(contractId);
        const instanceKey = contract.getFootprint();
        const instanceKeyData = instanceKey.contractData();
        const wasmHash = Buffer.alloc(32, seed + 1);

        const instance = new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
            storage: null,
        });
        const instanceData = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
            ext: new xdr.ExtensionPoint(0),
            contract: instanceKeyData.contract(),
            key: instanceKeyData.key(),
            durability: xdr.ContractDataDurability.persistent(),
            val: xdr.ScVal.scvContractInstance(instance),
        }));

        const wasmKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
        const wasmData = xdr.LedgerEntryData.contractCode(new xdr.ContractCodeEntry({
            ext: new xdr.ContractCodeEntryExt(0),
            hash: wasmHash,
            code: Buffer.from("0061736d01000000", "hex"),
        }));

        this.putEntry(instanceKey, instanceData, ttlLedgers);
        this.putEntry(wasmKey, wasmData, ttlLedgers + 1);

        return {
            contractId,
            wasmHashHex: wasmHash.toString("hex"),
            instanceKeyXdr: instanceKey.toXDR("base64"),
            wasmKeyXdr: wasmKey.toXDR("base64"),
        };
    }

    advanceLedgers(count: number): void {
        if (count < 0) throw new Error("Cannot move sandbox ledger backwards");
        this.latestLedger += count;
    }

    remainingTtl(entryKeyXdr: string): number | undefined {
        const entry = this.entries.get(entryKeyXdr);
        return entry ? entry.liveUntilLedgerSeq - this.latestLedger : undefined;
    }

    private putEntry(key: xdr.LedgerKey, val: xdr.LedgerEntryData, ttlLedgers: number): void {
        this.entries.set(key.toXDR("base64"), {
            key,
            val,
            liveUntilLedgerSeq: this.latestLedger + ttlLedgers,
            lastModifiedLedgerSeq: this.latestLedger,
        });
    }

    private async listen(): Promise<void> {
        this.server = createServer((request, response) => {
            void this.handleRequest(request, response);
        });

        await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
        const address = this.server.address() as AddressInfo;
        this.rpcUrl = `http://127.0.0.1:${address.port}`;
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (request.method !== "POST") {
            this.writeJson(response, 405, { error: "Only POST is supported" });
            return;
        }

        const body = await this.readBody(request);
        let payload: { id?: unknown; method?: string; params?: any };
        try {
            payload = JSON.parse(body);
        } catch {
            this.writeJson(response, 400, { error: "Invalid JSON" });
            return;
        }

        try {
            const result = this.dispatch(payload.method, payload.params ?? {});
            this.writeJson(response, 200, { jsonrpc: "2.0", id: payload.id ?? 1, result });
        } catch (error) {
            this.writeJson(response, 200, {
                jsonrpc: "2.0",
                id: payload.id ?? 1,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    private dispatch(method: string | undefined, params: any): unknown {
        switch (method) {
            case "getHealth":
                return {
                    status: "healthy",
                    latestLedger: this.latestLedger,
                    oldestLedger: Math.max(1, this.latestLedger - 1000),
                    ledgerRetentionWindow: 1000,
                };
            case "getNetwork":
                return {
                    passphrase: SANDBOX_PASSPHRASE,
                    protocolVersion: "23",
                };
            case "getLedgerEntries":
                return this.getLedgerEntries(params.keys ?? []);
            case "simulateTransaction":
                return this.simulateTransaction(params.transaction);
            case "sendTransaction":
                return this.sendTransaction(params.transaction);
            case "getTransaction":
                return this.getTransaction(params.hash);
            default:
                throw new Error(`Unsupported sandbox RPC method: ${method}`);
        }
    }

    private getLedgerEntries(keyXdrs: string[]): unknown {
        const entries = keyXdrs.flatMap((keyXdr) => {
            const key = xdr.LedgerKey.fromXDR(keyXdr, "base64");

            if (key.switch().name === "account") {
                return [this.accountLedgerEntry(key)];
            }

            const entry = this.entries.get(keyXdr);
            if (!entry || entry.liveUntilLedgerSeq <= this.latestLedger) return [];

            return [{
                key: entry.key.toXDR("base64"),
                xdr: entry.val.toXDR("base64"),
                lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
                liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
            }];
        });

        return { latestLedger: this.latestLedger, entries };
    }

    private accountLedgerEntry(key: xdr.LedgerKey): unknown {
        const accountId = key.account().accountId();
        const account = new xdr.AccountEntry({
            accountId,
            balance: xdr.Int64.fromString("100000000000"),
            seqNum: xdr.Int64.fromString("123456789") as any,
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 1, 1, 1]),
            signers: [],
            ext: new xdr.AccountEntryExt(0),
        });

        return {
            key: key.toXDR("base64"),
            xdr: xdr.LedgerEntryData.account(account).toXDR("base64"),
            lastModifiedLedgerSeq: this.latestLedger,
            liveUntilLedgerSeq: this.latestLedger + 1_000_000,
        };
    }

    private simulateTransaction(transactionXdr: string): unknown {
        const sorobanData = this.sorobanDataFromTransaction(transactionXdr);
        return {
            id: "1",
            latestLedger: this.latestLedger,
            transactionData: sorobanData.toXDR("base64"),
            minResourceFee: "100",
            events: [],
            results: [],
        };
    }

    private sendTransaction(transactionXdr: string): unknown {
        const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
        const tx = envelope.v1().tx();
        const operation = tx.operations()[0];
        if (!operation) throw new Error("Sandbox only supports single-operation transactions");

        if (operation.body().switch().name === "extendFootprintTtl") {
            const extendTo = operation.body().extendFootprintTtlOp().extendTo();
            const sorobanData = tx.ext().value();
            if (!sorobanData || typeof (sorobanData as any).resources !== "function") {
                throw new Error("Missing Soroban transaction data");
            }
            const footprint = (sorobanData as xdr.SorobanTransactionData).resources().footprint();
            for (const key of footprint.readOnly()) {
                const keyXdr = key.toXDR("base64");
                const entry = this.entries.get(keyXdr);
                if (!entry || entry.liveUntilLedgerSeq <= this.latestLedger) {
                    throw new Error(`Cannot extend missing or archived entry ${keyXdr}`);
                }
                entry.liveUntilLedgerSeq = this.latestLedger + extendTo;
                entry.lastModifiedLedgerSeq = this.latestLedger;
            }
        } else if (operation.body().switch().name !== "restoreFootprint") {
            throw new Error(`Unsupported sandbox operation: ${operation.body().switch().name}`);
        }

        this.latestLedger += 1;
        const hash = createHash("sha256").update(transactionXdr).digest("hex");
        this.submittedTransactions.set(hash, { hash, ledger: this.latestLedger, envelopeXdr: transactionXdr });

        return {
            status: "PENDING",
            hash,
            latestLedger: this.latestLedger,
            latestLedgerCloseTime: Date.now(),
        };
    }

    private getTransaction(hash: string): unknown {
        const submitted = this.submittedTransactions.get(hash);
        if (!submitted) {
            return {
                status: "NOT_FOUND",
                txHash: hash,
                latestLedger: this.latestLedger,
                latestLedgerCloseTime: Date.now(),
                oldestLedger: Math.max(1, this.latestLedger - 1000),
                oldestLedgerCloseTime: Date.now(),
            };
        }

        return {
            status: "SUCCESS",
            txHash: hash,
            ledger: submitted.ledger,
            latestLedger: this.latestLedger,
            latestLedgerCloseTime: Date.now(),
            oldestLedger: Math.max(1, this.latestLedger - 1000),
            oldestLedgerCloseTime: Date.now(),
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr: submitted.envelopeXdr,
            resultXdr: this.successResultXdr(),
            resultMetaXdr: this.successMetaXdr(),
            events: { contractEventsXdr: [], transactionEventsXdr: [] },
            createdAt: new Date().toISOString(),
        };
    }

    private sorobanDataFromTransaction(transactionXdr: string): xdr.SorobanTransactionData {
        const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
        const sorobanData = envelope.v1().tx().ext().value();
        if (!sorobanData) throw new Error("Missing Soroban transaction data");
        return sorobanData;
    }

    private successResultXdr(): string {
        return new xdr.TransactionResult({
            feeCharged: xdr.Int64.fromString("100"),
            result: xdr.TransactionResultResult.txSuccess([]),
            ext: new xdr.TransactionResultExt(0),
        }).toXDR("base64");
    }

    private successMetaXdr(): string {
        return new xdr.TransactionMeta(3, new xdr.TransactionMetaV3({
            ext: new xdr.ExtensionPoint(0),
            txChangesBefore: [],
            operations: [],
            txChangesAfter: [],
            sorobanMeta: null,
        })).toXDR("base64");
    }

    private readBody(request: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            request.on("error", reject);
        });
    }

    private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
    }
}

export function fundedSandboxKeypair(): Keypair {
    return Keypair.random();
}