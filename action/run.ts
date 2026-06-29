import { checkContractTTL, CheckResult } from "../src/core/check.js";

export interface ActionInputs {
    contractId: string;
    network: string;
    threshold: number;
    rpcUrl?: string;
}

export interface ActionOutput {
    exitCode: number;
    ttl: number;
    status: "passed" | "failed";
    message: string;
    result?: CheckResult;
}

/**
 * Runs the TTL check and returns structured output for the GitHub Action.
 * Testable without any process.exit or side effects.
 */
export async function runTTLCheckAction(inputs: ActionInputs): Promise<ActionOutput> {
    const result = await checkContractTTL(
        inputs.contractId,
        inputs.network,
        inputs.threshold,
        inputs.rpcUrl,
    );

    const status: "passed" | "failed" = result.passed ? "passed" : "failed";
    const exitCode = result.passed ? 0 : 1;

    let message: string;
    if (result.error) {
        message = `TTL check failed: ${result.error}`;
    } else if (result.passed) {
        message = `TTL check passed: minimumTTL=${result.minimumTTL} >= threshold=${inputs.threshold}`;
    } else {
        message = `TTL check failed: minimumTTL=${result.minimumTTL} < threshold=${inputs.threshold} for contract ${inputs.contractId}`;
    }

    return {
        exitCode,
        ttl: result.minimumTTL,
        status,
        message,
        result,
    };
}
