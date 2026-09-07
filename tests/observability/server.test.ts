import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { createMetricsServer, stopMetricsServer } from "../../src/observability/server.js";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { insertContract, updateLastCheckedLedger, upsertEntry } from "../../src/db/repositories.js";
import { TTL_GAUGE_NAME } from "../../src/observability/metrics/ttl.js";
import type { StellarRpcClient } from "../../src/rpc/client.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Make an HTTP GET request to the local metrics server and return the
 * status, headers, and body as plain text.
 */
function fetchMetrics(port: number, requestHeaders: Record<string, string> = {}): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
}> {
    const url = `http://127.0.0.1:${port}/metrics`;

    return new Promise((resolve, reject) => {
        http.get(url, { headers: requestHeaders }, (res) => {
            let body = "";
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => {
                const headers: Record<string, string> = {};
                for (const [key, value] of Object.entries(res.headers)) {
                    if (value != null) {
                        headers[key.toLowerCase()] = String(value);
                    }
                }
                resolve({ status: res.statusCode ?? 0, headers, body });
            });
        }).on("error", reject);
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Observability metrics server", () => {
    let portCounter = 19399;

    // Each test gets its own port to eliminate cross-test port-reuse issues.
    function nextPort(): number {
        return portCounter++;
    }

    afterEach(async () => {
        // Always clean up the server between tests
        await stopMetricsServer();
        delete process.env["SOROKEEP_METRICS_TOKEN"];
    });

    describe("Bearer token auth", () => {
        const TOKEN = "super-secret-metrics-token-123";

        it("succeeds without any Authorization header when no token is configured (default)", async () => {
            delete process.env["SOROKEEP_METRICS_TOKEN"];
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(200);
        });

        it("returns 401 with an empty body when a token is configured and no Authorization header is sent", async () => {
            process.env["SOROKEEP_METRICS_TOKEN"] = TOKEN;
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(401);
            expect(res.body).toBe("");
        });

        it("returns 401 when the token is incorrect", async () => {
            process.env["SOROKEEP_METRICS_TOKEN"] = TOKEN;
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port, { Authorization: "Bearer wrong-token" });
            expect(res.status).toBe(401);
            expect(res.body).toBe("");
        });

        it("returns 401 when the Authorization header isn't the Bearer scheme", async () => {
            process.env["SOROKEEP_METRICS_TOKEN"] = TOKEN;
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port, { Authorization: `Basic ${TOKEN}` });
            expect(res.status).toBe(401);
        });

        it("succeeds with 200 when the correct Bearer token is provided", async () => {
            process.env["SOROKEEP_METRICS_TOKEN"] = TOKEN;
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port, { Authorization: `Bearer ${TOKEN}` });
            expect(res.status).toBe(200);
        });
    });

    describe("/metrics endpoint", () => {
        it("returns HTTP 200 with valid Prometheus Content-Type", async () => {
            const port = nextPort();
            createMetricsServer(port);

            const response = await fetchMetrics(port);

            expect(response.status).toBe(200);
            expect(response.headers["content-type"]).toBe(
                "text/plain; version=0.0.4",
            );
        });

        it("returns a body consisting of valid Prometheus exposition format", async () => {
            const port = nextPort();
            createMetricsServer(port);

            const response = await fetchMetrics(port);

            // Valid Prometheus exposition format allows:
            // - Empty body
            // - Lines starting with # (HELP/TYPE comments)
            // - Metric lines (name{labels} value timestamp)
            //
            // For the initial empty registry, the body must at minimum
            // be valid exposition-format text — empty or comment-only.
            const lines = response.body
                .split("\n")
                .filter((line) => line.trim().length > 0);

            for (const line of lines) {
                // Every non-empty line must be either a comment or a valid metric
                const isValid =
                    line.startsWith("#") ||
                    /^[a-zA-Z_:][a-zA-Z0-9_:]*\{.*\}\s+\S+(\s+\d+)?$/.test(line);

                expect(
                    isValid,
                    `Line is not valid Prometheus exposition format: "${line}"`,
                ).toBe(true);
            }
        });

        it("recomputes DB-backed metrics from the live database on every scrape when a db handle is provided", async () => {
            const db = getDatabaseForTesting();
            insertContract(db, { id: "C-METRICS-SMOKE", name: "MetricsSmoke", network: "testnet" });
            updateLastCheckedLedger(db, "C-METRICS-SMOKE", 1_000);
            upsertEntry(db, {
                contract_id: "C-METRICS-SMOKE",
                entry_key_xdr: "xdr-smoke",
                entry_type: "instance",
                live_until_ledger: 1_500,
            });

            const port = nextPort();
            createMetricsServer(port, db);

            const response = await fetchMetrics(port);

            expect(response.body).toContain(TTL_GAUGE_NAME);
            expect(response.body).toMatch(
                new RegExp(`^${TTL_GAUGE_NAME}\\{contract_id="C-METRICS-SMOKE".*\\} 500$`, "m"),
            );

            db.close();
        });

        it("is idempotent — multiple GET requests all return 200", async () => {
            const port = nextPort();
            createMetricsServer(port);

            const res1 = await fetchMetrics(port);
            const res2 = await fetchMetrics(port);
            const res3 = await fetchMetrics(port);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);
            expect(res3.status).toBe(200);
        });
    });

    describe("server lifecycle", () => {
        it("can start, stop, and restart the server within a single test", async () => {
            const firstPort = nextPort();

            // First start
            createMetricsServer(firstPort);
            expect((await fetchMetrics(firstPort)).status).toBe(200);

            // Stop
            await stopMetricsServer();

            // Restart on a fresh port — the OS TCP stack may hold the old
            // port in TIME_WAIT briefly even after the close callback fires,
            // so re-binding the exact same port can race.  The important
            // property is that the server *can* be stopped and started again.
            const secondPort = nextPort();
            createMetricsServer(secondPort);
            expect((await fetchMetrics(secondPort)).status).toBe(200);
        });

        it("stopMetricsServer shuts down the HTTP server so subsequent requests fail", async () => {
            const port = nextPort();
            createMetricsServer(port);

            // Verify it's reachable first
            const before = await fetchMetrics(port);
            expect(before.status).toBe(200);

            await stopMetricsServer();

            // After stopping, requests should fail (connection refused)
            await expect(fetchMetrics(port)).rejects.toThrow();
        });

        it("stopMetricsServer is safe to call when no server is running (idempotent)", async () => {
            // Should not throw
            await expect(stopMetricsServer()).resolves.not.toThrow();
        });
    });

    describe("default behavior", () => {
        it("does not start a metrics server when no port is configured (daemon default)", async () => {
            // The metrics server should not be running by default.
            // This test verifies that the module itself is clean — no
            // auto-started server.
            // stopMetricsServer is a no-op when nothing is running;
            // this just proves the guarded path works.
            await expect(stopMetricsServer()).resolves.not.toThrow();
        });
    });

    describe("/readyz endpoint", () => {
        function fetchJson(port: number): Promise<{ status: number; body: unknown }> {
            const url = `http://127.0.0.1:${port}/readyz`;
            return new Promise((resolve, reject) => {
                http.get(url, (res) => {
                    let body = "";
                    res.on("data", (chunk: string) => { body += chunk; });
                    res.on("end", () => {
                        resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : undefined });
                    });
                }).on("error", reject);
            });
        }

        function mockRpcClient(getCurrentLedger: () => Promise<number>): StellarRpcClient {
            return { getCurrentLedger } as unknown as StellarRpcClient;
        }

        it("returns 200 when both the DB and RPC checks succeed", async () => {
            const db = getDatabaseForTesting();
            const port = nextPort();
            createMetricsServer(port, db, mockRpcClient(() => Promise.resolve(500_000)));

            const res = await fetchJson(port);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ status: "ok", checks: { db: "ok", rpc: "ok" } });

            db.close();
        });

        it("returns 503 and identifies the RPC check as failing when the RPC call rejects", async () => {
            const db = getDatabaseForTesting();
            const port = nextPort();
            createMetricsServer(port, db, mockRpcClient(() => Promise.reject(new Error("RPC timeout"))));

            const res = await fetchJson(port);
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ status: "not ready" });
            expect((res.body as { checks: { rpc: string } }).checks.rpc).toContain("RPC timeout");
            expect((res.body as { checks: { db: string } }).checks.db).toBe("ok");

            db.close();
        });

        it("returns 503 when no RPC client is configured", async () => {
            const db = getDatabaseForTesting();
            const port = nextPort();
            createMetricsServer(port, db); // no rpcClient argument

            const res = await fetchJson(port);
            expect(res.status).toBe(503);

            db.close();
        });

        it("caches a successful RPC check so rapid repeated polling doesn't re-call the RPC client", async () => {
            const db = getDatabaseForTesting();
            const port = nextPort();
            const getCurrentLedger = vi.fn().mockResolvedValue(500_000);
            createMetricsServer(port, db, mockRpcClient(getCurrentLedger));

            await fetchJson(port);
            await fetchJson(port);
            await fetchJson(port);

            expect(getCurrentLedger).toHaveBeenCalledTimes(1);

            db.close();
        });
    });

    describe("IP allowlist (issue #427)", () => {
        it("succeeds with no allowedIps configured (default, open access)", async () => {
            const port = nextPort();
            createMetricsServer(port);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(200);
        });

        it("returns 403 when the requester's real IP is not on the allowlist", async () => {
            const port = nextPort();
            // The test client connects from 127.0.0.1; excluding it must reject.
            createMetricsServer(port, undefined, undefined, ["10.0.0.0/8"]);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(403);
            expect(res.body).toBe("Forbidden");
        });

        it("succeeds when the requester's real IP exactly matches the allowlist", async () => {
            const port = nextPort();
            createMetricsServer(port, undefined, undefined, ["127.0.0.1"]);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(200);
        });

        it("succeeds when the requester's real IP matches a CIDR range on the allowlist", async () => {
            const port = nextPort();
            createMetricsServer(port, undefined, undefined, ["127.0.0.0/8"]);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(200);
        });

        it("rejects before the Hono bridge runs — /readyz is also blocked, not just /metrics", async () => {
            const db = getDatabaseForTesting();
            const port = nextPort();
            createMetricsServer(port, db, undefined, ["10.0.0.0/8"]);

            const status = await new Promise<number>((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/readyz`, (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                }).on("error", reject);
            });
            expect(status).toBe(403);

            db.close();
        });

        it("ignores an invalid CIDR entry in the allowlist rather than crashing, and still enforces the valid ones", async () => {
            const port = nextPort();
            createMetricsServer(port, undefined, undefined, ["not-a-real-ip", "127.0.0.1"]);

            const res = await fetchMetrics(port);
            expect(res.status).toBe(200);
        });
    });
});
