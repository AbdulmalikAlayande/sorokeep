Here is a patch that resolves the CodeRabbit review issues around the GitHub action and the check command:
``diff
From 90e8acd25b283440ccf11f8166f73f05ffba4649 Mon Sep 17 00:00:00 2001
From: AbdulmalikAlayande
 <114596864+AbdulmalikAlayande@users.noreply.github.com>
Date: Tue, 30 Jun 2026 21:14:48 +0100
Subject: [PATCH] fix(action): pin checkout, fix stderr propagation, fail
 closed on missing wasm

---
 .github/workflows/ttl-check.yml |  5 ++++-
 action/entrypoint.sh            |  2 +-
 src/commands/check.ts           | 19 ++++++++++++-------
 src/core/check.ts               | 11 +++++++++++
 stdout                          | 26 ++++++++++++++++++++++++++
 tests/core/check.test.ts        | 28 +++++++++++++++++++---------
 6 files changed, 73 insertions(+), 18 deletions(-)

diff --git a/.github/workflows/ttl-check.yml b/.github/workflows/ttl-check.yml
index bf7a0c9..7ee163b 100644
--- a/.github/workflows/ttl-check.yml
+++ b/.github/workflows/ttl-check.yml
@@ -17,6 +17,9 @@ on:
         required: false
         default: '500'
 
+permissions:
+  contents: read
+
 jobs:
   ttl-check:
     name: Soroban Contract TTL Check
@@ -29,7 +32,7 @@ jobs:
 
     steps:
       - name: Checkout repository
-        uses: actions/checkout@v4
+        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
 
       - name: Check contract TTL
         id: ttl
diff --git a/action/entrypoint.sh b/action/entrypoint.sh
index 2d9d19f..b3eeb24 100644
--- a/action/entrypoint.sh
+++ b/action/entrypoint.sh
@@ -18,7 +18,7 @@ echo "::group::Sorokeep TTL check G현 contract ${CONTRACT_ID} on ${NETWORK} (thr
 
 # Run check; capture output and exit code without aborting on failure.
 set +e
-CHECK_JSON=$(node "${ACTION_PATH}/dist/index.js" check "${ARGS[@]}" 2>&1)
+CHECK_JSON=$(node "${ACTION_PATH}/dist/index.js" check "${ARGS[@]}")
 CHECK_EXIT=$?
 set -e
 
diff --git a/src/commands/check.ts b/src/commands/check.ts
index 4e56524..329e187 100644
--- a/src/commands/check.ts
+++ b/src/commands/check.ts
@@ -15,11 +15,12 @@ export const registerCheckCommand = (program: Command): void => {
         .option("-r, --rpc-url <url>", "Custom RPC endpoint URL")
         .option("--json", "Output result as JSON (useful for CI integrations)")
         .action(async (contractId: string, options) => {
-            const threshold = parseInt(options.threshold, 10);
+            const threshold = Number(options.threshold);
 
-            if (isNaN(threshold) || threshold < 0) {
+            if (!Number.isInteger(threshold) || threshold < 0) {
                 console.error(chalk.red(`Invalid threshold: "${options.threshold}". Must be a non-negative integer.`));
-                process.exit(1);
+                process.exitCode = 1;
+                    return;
             }
 
             const spinner = options.json
@@ -45,13 +46,15 @@ export const registerCheckCommand = (program: Command): void => {
                         entries: result.entries,
                         error: result.error,
                     }));
-                    process.exit(result.passed ? 0 : 1);
+                    process.exitCode = result.passed ? 0 : 1;
+                    return;
                 }
 
                 if (result.error) {
                     spinner!.fail(chalk.red(`TTL check error: ${result.error}`));
                     logger.error("TTL check error", { error: result.error });
-                    process.exit(1);
+                    process.exitCode = 1;
+                    return;
                 }
 
                 const displayId = formatContractID(contractId);
@@ -83,7 +86,8 @@ export const registerCheckCommand = (program: Command): void => {
                     console.log(chalk.green(`\n  Minimum TTL (${result.minimumTTL.toLocaleString()}) meets threshold (${threshold.toLocaleString()}).`));
                 }
 
-                process.exit(result.passed ? 0 : 1);
+                process.exitCode = result.passed ? 0 : 1;
+                    return;
             } catch (error: unknown) {
                 const message = error instanceof Error ? error.message : String(error);
                 if (spinner) {
@@ -92,7 +96,8 @@ export const registerCheckCommand = (program: Command): void => {
                     console.error(chalk.red(`Failed to check TTL: ${message}`));
                 }
                 logger.error("Check command failed", { error: message });
-                process.exit(1);
+                process.exitCode = 1;
+                    return;
             }
         });
 };
diff --git a/src/core/check.ts b/src/core/check.ts
index d4b7b5f..460e58e 100644
--- a/src/core/check.ts
+++ b/src/core/check.ts
@@ -69,6 +69,17 @@ export async function checkContractTTL(
                     liveUntilLedger: wasmEntry.liveUntilLedgerSeq,
                     remainingTTL: wasmEntry.remainingTTL,
                 });
+            } else {
+                return {
+                    contractId,
+                    network,
+                    threshold,
+                    latestLedger: instanceEntry.latestLedger,
+                    minimumTTL: 0,
+                    passed: false,
+                    entries,
+                    error: `WASM code entry (hash: ${instanceEntry.wasmHash.substring(0, 10)}...) not found`,
+                };
             }
         }
 
diff --git a/stdout b/stdout
index 7ad057d..b84d4eb 100644
--- a/stdout
+++ b/stdout
@@ -77,3 +77,29 @@
 {"level":40,"time":1782762058391,"pid":25356,"hostname":"DESKTOP-82IQECC","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ESCALATE, entry: esc-key, remainingTTL: 3000, threshold: 5000"}
 {"level":40,"time":1782762058394,"pid":25356,"hostname":"DESKTOP-82IQECC","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: C_CRITICAL, entry: crit-key, remainingTTL: 3000, threshold: 10000"}
 {"level":40,"time":1782762060773,"pid":18092,"hostname":"DESKTOP-82IQECC","component":"Config","component":"Config","msg":"Failed to parse config at C:\\Users\\DELL\\AppData\\Local\\Temp\\sorokeep-config-test-1782762058903\\config.yaml: Flow map in block collection must be sufficiently indented and end with a } at line 1, column 17:\n\n{{invalid yaml::\n                ^\n. Using defaults."}
+{"level":40,"time":1782850463273,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ALERT, entry: alert-key, remainingTTL: 8000, threshold: 15000"}
+{"level":40,"time":1782850463285,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_NEAR, entry: near-key, remainingTTL: 9999, threshold: 10000"}
+{"level":40,"time":1782850463288,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_MULTI_ALERT, entry: ma-key, remainingTTL: 8000, threshold: 15000"}
+{"level":40,"time":1782850463289,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_MULTI_ALERT, entry: ma-key, remainingTTL: 8000, threshold: 12000"}
+{"level":40,"time":1782850463291,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ENTRIES_ALERT, entry: e-instance, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463291,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ENTRIES_ALERT, entry: e-wasm, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463295,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_EXPIRED, entry: exp-key, remainingTTL: -1000, threshold: 10000"}
+{"level":40,"time":1782850463298,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_DEDUP, entry: dedup-key, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463304,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_3CYCLE, entry: c3-key, remainingTTL: 3000, threshold: 10000"}
+{"level":40,"time":1782850463309,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_REFIRE, entry: rf-key, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463311,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_REFIRE, entry: rf-key, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463314,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_RESOLVE, entry: resolve-key, remainingTTL: 5000, threshold: 10000"}
+{"level":30,"time":1782850463318,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Alert resolved G현 contract: CONTRACT_RESOLVE, entry: resolve-key, remainingTTL: 120000, threshold: 10000"}
+{"level":40,"time":1782850463494,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_PARTIAL_RECOVER, entry: pr-key, remainingTTL: 5000, threshold: 20000"}
+{"level":40,"time":1782850463502,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_SELECTIVE_RESOLVE, entry: sr-instance, remainingTTL: 5000, threshold: 10000"}
+{"level":40,"time":1782850463502,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_SELECTIVE_RESOLVE, entry: sr-wasm, remainingTTL: 5000, threshold: 10000"}
+{"level":30,"time":1782850463503,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Alert resolved G현 contract: CONTRACT_SELECTIVE_RESOLVE, entry: sr-instance, remainingTTL: 100000, threshold: 10000"}
+{"level":50,"time":1782850463537,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","meta":[{}],"msg":"Error processing contract CONTRACT_FAIL: RPC timeout Error: RPC timeout\n    at C:\\Users\\HP\\code\\sorokeep\\tests\\core\\monitor.test.ts:598:40\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:174:14\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:558:28\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:61:24\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:41:12)\n    at runTest (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1137:17)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)"}
+{"level":50,"time":1782850463545,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","meta":[{}],"msg":"Error processing contract CONTRACT_ERR_ID: Connection refused Error: Connection refused\n    at C:\\Users\\HP\\code\\sorokeep\\tests\\core\\monitor.test.ts:612:48\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:174:14\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:558:28\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:61:24\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:41:12)\n    at runTest (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1137:17)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)"}
+{"level":50,"time":1782850463552,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","meta":[{}],"msg":"Error processing contract C_FAIL_1: Network down Error: Network down\n    at C:\\Users\\HP\\code\\sorokeep\\tests\\core\\monitor.test.ts:624:48\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:174:14\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:558:28\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:61:24\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:41:12)\n    at runTest (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1137:17)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)"}
+{"level":50,"time":1782850463553,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","meta":[{}],"msg":"Error processing contract C_FAIL_2: Network down Error: Network down\n    at C:\\Users\\HP\\code\\sorokeep\\tests\\core\\monitor.test.ts:624:48\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:174:14\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:558:28\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:61:24\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:41:12)\n    at runTest (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1137:17)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)"}
+{"level":50,"time":1782850463559,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","meta":[{}],"msg":"Error processing contract CONTRACT_NO_UPDATE: Timeout Error: Timeout\n    at C:\\Users\\HP\\code\\sorokeep\\tests\\core\\monitor.test.ts:639:48\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:174:14\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:558:28\n    at file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:61:24\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:41:12)\n    at runTest (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1137:17)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)\n    at runSuite (file:///C:/Users/HP/code/sorokeep/node_modules/@vitest/runner/dist/index.js:1291:15)"}
+{"level":40,"time":1782850463570,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_TIERED, entry: tier-key, remainingTTL: 18000, threshold: 20000"}
+{"level":40,"time":1782850463578,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ESCALATE, entry: esc-key, remainingTTL: 18000, threshold: 20000"}
+{"level":40,"time":1782850463578,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: CONTRACT_ESCALATE, entry: esc-key, remainingTTL: 3000, threshold: 5000"}
+{"level":40,"time":1782850463586,"pid":1552,"hostname":"Abdulmalik","component":"MonitorCycle","component":"MonitorCycle","msg":"Threshold crossed G현 contract: C_CRITICAL, entry: crit-key, remainingTTL: 3000, threshold: 10000"}
diff --git a/tests/core/check.test.ts b/tests/core/check.test.ts
index 87c153c..a0bed74 100644
--- a/tests/core/check.test.ts
+++ b/tests/core/check.test.ts
@@ -4,12 +4,15 @@ import { checkContractTTL, CheckResult } from "../../src/core/check.js";
 const mockGetContractInstanceEntry = vi.fn();
 const mockGetWasmCodeEntry = vi.fn();
 
-vi.mock("../../src/rpc/client.js", () => {
-    class MockStellarRpcClient {
-        getContractInstanceEntry = mockGetContractInstanceEntry;
-        getWasmCodeEntry = mockGetWasmCodeEntry;
-    }
-    return { StellarRpcClient: MockStellarRpcClient };
+export const mockStellarRpcClientConstructor = vi.fn();
+vi.mock('../../src/rpc/client.js', () => {
+    return {
+        StellarRpcClient: vi.fn().mockImplementation(function (this: any, ...args: any[]) {
+            mockStellarRpcClientConstructor(...args);
+            this.getContractInstanceEntry = mockGetContractInstanceEntry;
+            this.getWasmCodeEntry = mockGetWasmCodeEntry;
+        })
+    };
 });
 
 const VALID_CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
@@ -72,6 +75,12 @@ describe("checkContractTTL", () => {
             expect(result.network).toBe("mainnet");
             expect(result.threshold).toBe(1000);
         });
+
+        it("passes rpcUrl to StellarRpcClient", async () => {
+            mockInstance(5000, null);
+            await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500, "https://custom.rpc");
+            expect(mockStellarRpcClientConstructor).toHaveBeenCalledWith("testnet", "https://custom.rpc");
+        });
     });
 
     // =========================================================================
@@ -192,14 +201,15 @@ describe("checkContractTTL", () => {
             expect(result.entries[0]!.entryType).toBe("instance");
         });
 
-        it("uses instance TTL only when WASM entry is not found on RPC", async () => {
+        it("fails closed when WASM entry is not found on RPC", async () => {
             mockInstance(5000);
             mockGetWasmCodeEntry.mockResolvedValue(null);
 
             const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);
 
-            expect(result.entries).toHaveLength(1);
-            expect(result.minimumTTL).toBe(5000);
+            expect(result.passed).toBe(false);
+            expect(result.minimumTTL).toBe(0);
+            expect(result.error).toMatch(/WASM code entry.*not found/);
         });
     });
 
-- 
2.49.0.windows.1


``
