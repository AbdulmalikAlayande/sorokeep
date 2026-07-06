const fs = require('fs');

// 1. .github/workflows/ttl-check.yml
let wf = fs.readFileSync('.github/workflows/ttl-check.yml', 'utf8');
wf = wf.replace(
    /        required: false\r?\n        default: '500'\r?\n\r?\njobs:/,
    "        required: false\n        default: '500'\n\npermissions:\n  contents: read\n\njobs:"
);
wf = wf.replace(
    /        uses: actions\/checkout@v4/,
    "        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2"
);
fs.writeFileSync('.github/workflows/ttl-check.yml', wf);

// 2. action/entrypoint.sh
let ep = fs.readFileSync('action/entrypoint.sh', 'utf8');
ep = ep.replace(
    /CHECK_JSON=\$\(node "\$\{ACTION_PATH\}\/dist\/index\.js" check "\$\{ARGS\[@\]\}" 2>&1\)/,
    'CHECK_JSON=$(node "${ACTION_PATH}/dist/index.js" check "${ARGS[@]}")'
);
fs.writeFileSync('action/entrypoint.sh', ep);

// 3. src/commands/check.ts
let check = fs.readFileSync('src/commands/check.ts', 'utf8');
check = check.replace(
    /const threshold = parseInt\(options\.threshold, 10\);\r?\n\r?\n            if \(isNaN\(threshold\) \|\| threshold < 0\) \{/,
    'const threshold = Number(options.threshold);\n\n            if (!Number.isInteger(threshold) || threshold < 0) {'
);
check = check.replace(
    /process\.exit\(1\);/g,
    'process.exitCode = 1;\n                    return;'
);
check = check.replace(
    /process\.exit\(result\.passed \? 0 : 1\);/g,
    'process.exitCode = result.passed ? 0 : 1;\n                    return;'
);
fs.writeFileSync('src/commands/check.ts', check);

// 4. src/core/check.ts
let checkCore = fs.readFileSync('src/core/check.ts', 'utf8');
checkCore = checkCore.replace(
    /        if \(instanceEntry\.wasmHash\) \{\r?\n            const wasmEntry = await client\.getWasmCodeEntry\(instanceEntry\.wasmHash\);\r?\n            if \(wasmEntry\) \{\r?\n                entries\.push\(\{\r?\n                    entryKeyXdr: wasmEntry\.entryKeyXdr,\r?\n                    entryType: "wasm",\r?\n                    liveUntilLedger: wasmEntry\.liveUntilLedgerSeq,\r?\n                    remainingTTL: wasmEntry\.remainingTTL,\r?\n                \}\);\r?\n            \}\r?\n        \}/,
    `        if (instanceEntry.wasmHash) {\n            const wasmEntry = await client.getWasmCodeEntry(instanceEntry.wasmHash);\n            if (wasmEntry) {\n                entries.push({\n                    entryKeyXdr: wasmEntry.entryKeyXdr,\n                    entryType: "wasm",\n                    liveUntilLedger: wasmEntry.liveUntilLedgerSeq,\n                    remainingTTL: wasmEntry.remainingTTL,\n                });\n            } else {\n                return {\n                    contractId,\n                    network,\n                    threshold,\n                    latestLedger: instanceEntry.latestLedger,\n                    minimumTTL: 0,\n                    passed: false,\n                    entries,\n                    error: \`WASM code entry (hash: \${instanceEntry.wasmHash.substring(0, 10)}...) not found\`,\n                };\n            }\n        }`
);
fs.writeFileSync('src/core/check.ts', checkCore);

// 5. tests/core/check.test.ts
let checkTest = fs.readFileSync('tests/core/check.test.ts', 'utf8');
checkTest = checkTest.replace(
    /vi\.mock\("\.\.\/\.\.\/src\/rpc\/client\.js", \(\) => \{\r?\n    class MockStellarRpcClient \{\r?\n        getContractInstanceEntry = mockGetContractInstanceEntry;\r?\n        getWasmCodeEntry = mockGetWasmCodeEntry;\r?\n    \}\r?\n    return \{ StellarRpcClient: MockStellarRpcClient \};\r?\n\}\);/,
    "export const mockStellarRpcClientConstructor = vi.fn();\nvi.mock('../../src/rpc/client.js', () => {\n    return {\n        StellarRpcClient: vi.fn().mockImplementation(function (this: any, ...args: any[]) {\n            mockStellarRpcClientConstructor(...args);\n            this.getContractInstanceEntry = mockGetContractInstanceEntry;\n            this.getWasmCodeEntry = mockGetWasmCodeEntry;\n        })\n    };\n});"
);
checkTest = checkTest.replace(
    /            expect\(result\.threshold\)\.toBe\(1000\);\r?\n        \}\);\r?\n    \}\);/,
    '            expect(result.threshold).toBe(1000);\n        });\n\n        it("passes rpcUrl to StellarRpcClient", async () => {\n            mockInstance(5000, null);\n            await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500, "https://custom.rpc");\n            expect(mockStellarRpcClientConstructor).toHaveBeenCalledWith("testnet", "https://custom.rpc");\n        });\n    });'
);
checkTest = checkTest.replace(
    /        it\("uses instance TTL only when WASM entry is not found on RPC", async \(\) => \{\r?\n            mockInstance\(5000\);\r?\n            mockGetWasmCodeEntry\.mockResolvedValue\(null\);\r?\n\r?\n            const result = await checkContractTTL\(VALID_CONTRACT_ID, "testnet", 500\);\r?\n\r?\n            expect\(result\.entries\)\.toHaveLength\(1\);\r?\n            expect\(result\.minimumTTL\)\.toBe\(5000\);\r?\n        \}\);/,
    '        it("fails closed when WASM entry is not found on RPC", async () => {\n            mockInstance(5000);\n            mockGetWasmCodeEntry.mockResolvedValue(null);\n\n            const result = await checkContractTTL(VALID_CONTRACT_ID, "testnet", 500);\n\n            expect(result.passed).toBe(false);\n            expect(result.minimumTTL).toBe(0);\n            expect(result.error).toMatch(/WASM code entry.*not found/);\n        });'
);
fs.writeFileSync('tests/core/check.test.ts', checkTest);

console.log('All patches applied.');