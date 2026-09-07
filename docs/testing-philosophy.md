# Testing Philosophy

Sorokeep enforces strict Test-Driven Development (TDD). This document explains
why, how the test suite is structured, and the exact patterns you need to follow
when contributing.

## Table of Contents

- [Why TDD?](#why-tdd)
- [Directory Convention: tests/ mirrors src/](#directory-convention-tests-mirrors-src)
- [In-Memory SQLite: the getDatabaseForTesting() Pattern](#in-memory-sqlite-the-getdatabasefortesting-pattern)
- [Mocking External Dependencies with vi.mock()](#mocking-external-dependencies-with-vimock)
  - [Mocking the Stellar RPC client](#mocking-the-stellar-rpc-client)
  - [Mocking third-party packages with vi.importActual](#mocking-third-party-packages-with-viimportactual)
  - [Using vi.hoisted() for variables referenced inside vi.mock()](#using-vihoisted-for-variables-referenced-inside-vimock)
- [Coverage Thresholds and How to Read a Report](#coverage-thresholds-and-how-to-read-a-report)

---

## Why TDD?

Sorokeep is an off-chain operations tool that submits real Stellar transactions,
reads on-chain state, and fires alerts to external services. A bug in the monitor
cycle, the extension logic, or the alert dispatcher can have real financial
consequences — missed TTL extensions can archive a live contract.

TDD enforces this discipline:

1. **Write the test first.** Define what the function must do before you write the
   function. The test is your specification.
2. **Watch it fail (red).** A test that can never fail doesn't prove anything.
3. **Write the minimum code to make it pass (green).** Don't over-engineer.
4. **Refactor** with confidence — your tests are a safety net.

The practical benefit: every path in the codebase has a test that was written
_before_ the code. Reviewers can read the test to understand what the code is
supposed to do. Regressions are caught immediately.

**Tests that don't follow TDD will not be accepted in PRs.**

---

## Directory Convention: tests/ mirrors src/

Every test file lives in `tests/` under a sub-directory that mirrors the
corresponding sub-directory in `src/`. The file name matches the source file
with a `.test.ts` suffix.

```
src/core/monitor.ts            →  tests/core/monitor.test.ts
src/db/repositories.ts         →  tests/db/repositories.test.ts
src/alerts/dispatcher.ts       →  tests/alerts/dispatcher.test.ts
src/rpc/client.ts              →  tests/rpc/client.test.ts
src/commands/watch.ts          →  tests/commands/watch.test.ts
```

The mapping is enforced automatically. A CI script
(`scripts/check-test-file-locations.mjs`) fails the build if a test file is
placed outside the mirrored path.

When you add `src/core/my-feature.ts`, create `tests/core/my-feature.test.ts`.
Don't put the test anywhere else.

---

## In-Memory SQLite: the getDatabaseForTesting() Pattern

All database tests use `getDatabaseForTesting()` from `src/db/database.ts`.
This function opens a fresh `better-sqlite3` connection to `:memory:`, runs the
full `schema.sql`, and returns the handle. Each call produces a completely
independent, empty database — no shared state between tests.

**Why in-memory?** See [ADR-006](adr/ADR-006-in-memory-sqlite-for-testing.md)
for the full rationale. The short version: it's the same SQLite engine as
production, it's fast (no I/O), it's isolated (no test can pollute another),
and it leaves no files on disk after the suite finishes.

### Standard setup

Pull this directly from `tests/db/repositories.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import * as repo from "../../src/db/repositories.js";

describe("Database Repositories", () => {
    let db: ReturnType<typeof getDatabaseForTesting>;

    beforeEach(() => {
        // getDatabaseForTesting() execs the current schema.sql directly into a
        // fresh :memory: database, so it already has every column/table/CHECK
        // schema.sql defines — no need to replay ad-hoc migrations here.
        db = getDatabaseForTesting();
    });

    afterEach(() => {
        db.close();
    });

    it("inserts, gets, and deletes a contract", () => {
        repo.insertContract(db, { id: "C1", network: "testnet", name: "My Contract" });

        const contract = repo.getContract(db, "C1");
        expect(contract).toBeDefined();
        expect(contract?.name).toBe("My Contract");

        repo.deleteContract(db, "C1");
        expect(repo.getContract(db, "C1")).toBeUndefined();
    });
});
```

Key rules:
- Create the database in `beforeEach`, not at module level. Module-level
  databases are shared across tests in the same file.
- Close the database in `afterEach`. This frees the in-memory handle
  immediately and keeps memory usage flat across the suite.
- Never use the production database path (`~/.sorokeep/sorokeep.db`) in tests.
  `getDatabaseForTesting()` is the only correct way to create a test database.

---

## Mocking External Dependencies with vi.mock()

Sorokeep's core logic depends on the Stellar RPC (`src/rpc/client.ts`), the
alert dispatcher (`src/alerts/dispatcher.ts`), and the logger
(`src/logging/index.ts`). Tests for the core layer mock all of these so no
network calls are made and no real alerts are fired.

Vitest hoists `vi.mock()` calls to the top of the module — they execute before
any `import` statements. Always place `vi.mock()` at the top level of a test
file, not inside `beforeEach` or a `describe` block.

### Mocking the Stellar RPC client

The pattern used throughout `tests/core/` (e.g. `tests/core/monitor.test.ts`)
is to replace `StellarRpcClient` with a minimal mock class that exposes the
same method names as `vi.fn()` instances. The mock is constructed by the
module under test, so the class constructor must be exported under the same
name.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { runMonitorCycle } from "../../src/core/monitor.js";

// Declare the spies at module scope so tests can call .mockResolvedValue() etc.
const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();

// vi.mock is hoisted — this runs before the imports above are resolved.
vi.mock("../../src/rpc/client.js", () => {
    class MockStellarRpcClient {
        getEntryTTLs = mockGetEntryTTLs;
        getCurrentLedger = mockGetCurrentLedger;
        getNetwork = vi.fn().mockReturnValue("testnet");
    }
    return { StellarRpcClient: MockStellarRpcClient };
});

describe("runMonitorCycle", () => {
    let db: ReturnType<typeof getDatabaseForTesting>;

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        mockGetCurrentLedger.mockResolvedValue(2_500_000);
    });

    it("fires an alert when TTL drops below threshold", async () => {
        // arrange: seed DB, configure mockGetEntryTTLs response ...
        // act: await runMonitorCycle(...)
        // assert: check DB state or mock call counts
    });
});
```

The same pattern applies when mocking `src/core/extension.js`,
`src/alerts/dispatcher.js`, or any other internal module:

```typescript
const mockRunAutoExtensions = vi.fn();

vi.mock("../../src/core/extension.js", () => ({
    runAutoExtensions: (...args: unknown[]) => mockRunAutoExtensions(...args),
}));
```

### Mocking third-party packages with vi.importActual

When you need to replace only part of a third-party package (e.g. the RPC
server class inside `@stellar/stellar-sdk`), use the async factory form of
`vi.mock()` together with `vi.importActual`. This preserves all the real exports
you don't need to replace while swapping out the one you do.

Pull this pattern directly from `tests/rpc/client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { StellarRpcClient } from "../../src/rpc/client.js";

vi.mock("@stellar/stellar-sdk", async () => {
    // Bring in the real module so we can spread it below.
    const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
        "@stellar/stellar-sdk"
    );

    class MockRPCServer {
        constructor(public serverUrl: string) {}

        async getHealth() {
            return { status: "healthy", latestLedger: 2_443_398 };
        }

        async getLedgerEntries(...keys: unknown[]) {
            return { latestLedger: 2_443_398, entries: [] };
        }
    }

    return {
        // Keep every real export intact ...
        ...actual,
        // ... but replace only the RPC server with the mock.
        rpc: { ...(actual.rpc as object), Server: MockRPCServer },
    };
});

describe("StellarRpcClient", () => {
    it("constructs without throwing", () => {
        const client = new StellarRpcClient("https://soroban-testnet.stellar.org");
        expect(client).toBeDefined();
    });
});
```

### Using vi.hoisted() for variables referenced inside vi.mock()

`vi.mock()` is hoisted to run before imports, which means module-level
variables declared with `const` are not yet initialized when the mock factory
runs. If your mock factory needs to reference a `vi.fn()` spy that is also
used in test assertions, wrap those spies in `vi.hoisted()`.

This pattern is used in `tests/core/monitor.test.ts` to share the
`mockDeliverSingleAlert` spy between the `vi.mock()` factory and the test
assertions:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() runs before vi.mock() factories — safe to reference here.
const { mockDeliverSingleAlert, mockLoggerFns } = vi.hoisted(() => {
    const mockDeliverSingleAlert = vi.fn();
    const mockLoggerFns = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
    };
    mockLoggerFns.child.mockReturnValue(mockLoggerFns);
    return { mockDeliverSingleAlert, mockLoggerFns };
});

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverSingleAlert: (...args: unknown[]) => mockDeliverSingleAlert(...args),
}));

vi.mock("../../src/logging/index.js", () => ({
    getLogger: () => mockLoggerFns,
}));

describe("alert delivery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("calls deliverSingleAlert with correct args", async () => {
        // ... test body ...
        expect(mockDeliverSingleAlert).toHaveBeenCalledWith(/* ... */);
    });
});
```

Rule of thumb: if the spy must be accessible _both_ inside a `vi.mock()`
factory and in a test assertion, use `vi.hoisted()`. If the spy is only needed
inside the factory (e.g. a simple method stub), a plain `vi.fn()` inside the
factory is fine.

### Alert channel mock helper

Tests for the alert dispatcher (`tests/alerts/dispatcher.test.ts`) use a
`mockChannel()` helper that returns an object matching the `AlertChannel`
interface with a `send` spy:

```typescript
import { vi } from "vitest";
import type { AlertChannel } from "../../src/alerts/types.js";

function mockChannel(): AlertChannel & { send: ReturnType<typeof vi.fn> } {
    return { send: vi.fn().mockResolvedValue(undefined) };
}
```

Use this helper (or the same pattern) whenever you need a stand-in for a
delivery channel in a test that exercises the dispatcher.

---

## Coverage Thresholds and How to Read a Report

Coverage is collected by Vitest with the V8 provider. The thresholds are
configured in `vitest.config.ts`:

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | 65%       |
| Functions  | 85%       |
| Branches   | 75%       |
| Statements | 65%       |

The functions threshold (85%) is the tightest. Every public function in `src/`
should have at least one test that calls it. A new function with no test will
likely drop the functions metric below the threshold and fail CI.

### Running a coverage report locally

```bash
npx vitest run --coverage
```

After the run, open `coverage/index.html` in a browser for a navigable
source-annotated view:

```bash
# Linux / WSL
xdg-open coverage/index.html

# macOS
open coverage/index.html
```

### Reading the terminal output

The terminal summary looks like this:

```
 % Coverage report from v8
File                         | % Stmts | % Branch | % Funcs | % Lines
-----------------------------|---------|----------|---------|--------
src/core/monitor.ts          |   92.30 |    88.10 |  100.00 |   92.30
src/alerts/dispatcher.ts     |   87.50 |    75.00 |  100.00 |   87.50
src/db/repositories.ts       |   70.10 |    65.00 |   88.00 |   70.10
...
```

Lines highlighted in red in the HTML report are uncovered. Focus on:

1. **Red functions** — the highest-impact gaps. Adding a single test that
   exercises the function can recover several percentage points.
2. **Red branches** — an `if` or `switch` arm that has never been taken.
   Write a test that forces the else branch or the missing case.
3. **Red lines inside a function you've already tested** — usually an error
   path (e.g. `catch` block, early return on bad input). Add a test that
   triggers the error.

### What to do when CI fails on coverage

1. Run `npx vitest run --coverage` locally.
2. Find the file(s) where coverage dropped (the terminal diff highlights them).
3. Open `coverage/<file>.ts.html` to see exactly which lines are red.
4. Write tests that exercise those paths.
5. Re-run coverage to confirm the thresholds pass before pushing.

Do not lower the thresholds to make a failing build pass. If a new feature
genuinely cannot be covered (e.g. a platform-specific code path), open a
discussion on the PR.
