import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTTLCheckAction, ActionInputs, ActionOutput } from "../../action/run.js";

const mockCheckContractTTL = vi.fn();

vi.mock("../../src/core/check.js", () => ({
    checkContractTTL: (...args: unknown[]) => mockCheckContractTTL(...args),
}));

const VALID_CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

function makePassingCheckResult(minimumTTL: number) {
    return {
        contractId: VALID_CONTRACT_ID,
        network: "testnet",
        threshold: 500,
        latestLedger: 2_500_000,
        minimumTTL,
        passed: minimumTTL >= 500,
        entries: [{ entryType: "instance", remainingTTL: minimumTTL, entryKeyXdr: "key", liveUntilLedger: 2_500_000 + minimumTTL }],
    };
}

describe("runTTLCheckAction", () => {
    const baseInputs: ActionInputs = {
        contractId: VALID_CONTRACT_ID,
        network: "testnet",
        threshold: 500,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. RETURN SHAPE
    // =========================================================================
    describe("Return shape", () => {
        it("returns all required output fields", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            const output: ActionOutput = await runTTLCheckAction(baseInputs);

            expect(output).toHaveProperty("exitCode");
            expect(output).toHaveProperty("ttl");
            expect(output).toHaveProperty("status");
            expect(output).toHaveProperty("message");
        });

        it("passes all inputs through to checkContractTTL", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            await runTTLCheckAction({
                contractId: VALID_CONTRACT_ID,
                network: "mainnet",
                threshold: 1000,
                rpcUrl: "https://custom-rpc.example.com",
            });

            expect(mockCheckContractTTL).toHaveBeenCalledWith(
                VALID_CONTRACT_ID,
                "mainnet",
                1000,
                "https://custom-rpc.example.com",
            );
        });

        it("passes undefined rpcUrl when not provided", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            await runTTLCheckAction(baseInputs);

            expect(mockCheckContractTTL).toHaveBeenCalledWith(
                VALID_CONTRACT_ID,
                "testnet",
                500,
                undefined,
            );
        });
    });

    // =========================================================================
    // 2. EXIT CODE
    // =========================================================================
    describe("Exit code", () => {
        it("returns exitCode 0 when TTL check passes", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(0);
        });

        it("returns exitCode 1 when TTL check fails (TTL below threshold)", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(100));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(1);
        });

        it("returns exitCode 1 when contract is not found", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(0),
                passed: false,
                minimumTTL: 0,
                error: "Contract not found on testnet",
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(1);
        });

        it("returns exitCode 1 on RPC network error", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(0),
                passed: false,
                minimumTTL: 0,
                error: "Connection refused",
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(1);
        });
    });

    // =========================================================================
    // 3. STATUS FIELD
    // =========================================================================
    describe("Status field", () => {
        it("sets status to 'passed' when TTL is above threshold", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.status).toBe("passed");
        });

        it("sets status to 'failed' when TTL is below threshold", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(100));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.status).toBe("failed");
        });

        it("sets status to 'passed' when TTL equals threshold exactly", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(500),
                passed: true,
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.status).toBe("passed");
        });

        it("sets status to 'failed' when TTL is expired (0)", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(0),
                passed: false,
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.status).toBe("failed");
        });
    });

    // =========================================================================
    // 4. TTL OUTPUT
    // =========================================================================
    describe("TTL output", () => {
        it("reports the minimum TTL from the check result", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(8765));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.ttl).toBe(8765);
        });

        it("reports TTL as 0 when check returns minimumTTL of 0", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(0),
                passed: false,
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.ttl).toBe(0);
        });
    });

    // =========================================================================
    // 5. MESSAGE
    // =========================================================================
    describe("Message", () => {
        it("message mentions 'passed' when check succeeds", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(5000));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.message.toLowerCase()).toMatch(/passed/);
        });

        it("message mentions 'failed' when check fails due to low TTL", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(100));

            const output = await runTTLCheckAction(baseInputs);

            expect(output.message.toLowerCase()).toMatch(/failed/);
        });

        it("message includes the error text when check returns an error", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(0),
                passed: false,
                error: "Contract not found on testnet",
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.message).toMatch(/Contract not found/i);
        });
    });

    // =========================================================================
    // 6. WORKFLOW ACCEPTANCE CRITERIA
    // =========================================================================
    describe("Acceptance criteria: workflow pass/fail behavior", () => {
        it("succeeds (exitCode=0) when contract TTL is well above threshold — action runs successfully on PR workflow", async () => {
            mockCheckContractTTL.mockResolvedValue(makePassingCheckResult(100_000));

            const output = await runTTLCheckAction({
                contractId: VALID_CONTRACT_ID,
                network: "testnet",
                threshold: 500,
            });

            expect(output.exitCode).toBe(0);
            expect(output.status).toBe("passed");
        });

        it("fails (exitCode=1) when contract TTL is below threshold — action fails the workflow run", async () => {
            mockCheckContractTTL.mockResolvedValue({
                ...makePassingCheckResult(100),
                passed: false,
            });

            const output = await runTTLCheckAction({
                contractId: VALID_CONTRACT_ID,
                network: "testnet",
                threshold: 500,
            });

            expect(output.exitCode).toBe(1);
            expect(output.status).toBe("failed");
        });

        it("fails (exitCode=1) when contract is not found on the network", async () => {
            mockCheckContractTTL.mockResolvedValue({
                contractId: VALID_CONTRACT_ID,
                network: "testnet",
                threshold: 500,
                latestLedger: 0,
                minimumTTL: 0,
                passed: false,
                entries: [],
                error: `Contract ${VALID_CONTRACT_ID} not found on testnet`,
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(1);
            expect(output.status).toBe("failed");
        });

        it("fails (exitCode=1) when RPC is unreachable", async () => {
            mockCheckContractTTL.mockResolvedValue({
                contractId: VALID_CONTRACT_ID,
                network: "testnet",
                threshold: 500,
                latestLedger: 0,
                minimumTTL: 0,
                passed: false,
                entries: [],
                error: "ECONNREFUSED",
            });

            const output = await runTTLCheckAction(baseInputs);

            expect(output.exitCode).toBe(1);
        });
    });
});
