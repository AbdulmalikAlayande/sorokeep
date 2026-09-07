import type Database from "better-sqlite3";
import { Hono } from "hono";
import http from "node:http";
import { register, collectAllMetrics } from "./registry.js";
import type { StellarRpcClient } from "../rpc/client.js";
import { checkIpAllowlist } from "../core/ipAllowlist.js";
import { getLogger } from "../logging/index.js";

const ipAllowlistLogger = getLogger().child({ component: "ObservabilityServer" });

// ─── Module-level state ──────────────────────────────────────────────────────

let activeServer: http.Server | null = null;
let activeDb: Database.Database | null = null;
let activeRpcClient: StellarRpcClient | null = null;

// ─── /readyz support ─────────────────────────────────────────────────────────

const RPC_CHECK_CACHE_TTL_MS = 5_000;
let rpcCheckCache: { ok: boolean; error?: string; checkedAt: number } | null = null;

function checkDb(db: Database.Database): { ok: boolean; error?: string } {
    try {
        db.prepare("SELECT 1").get();
        return { ok: true };
    } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Check RPC connectivity via a lightweight getCurrentLedger() call, caching
 * the result for RPC_CHECK_CACHE_TTL_MS so frequent /readyz polling (e.g.
 * a Kubernetes readiness probe every few seconds) doesn't hammer the RPC
 * endpoint.
 */
async function checkRpc(rpcClient: StellarRpcClient | null): Promise<{ ok: boolean; error?: string }> {
    if (!rpcClient) {
        return { ok: false, error: "no RPC client configured" };
    }

    if (rpcCheckCache && Date.now() - rpcCheckCache.checkedAt < RPC_CHECK_CACHE_TTL_MS) {
        return rpcCheckCache;
    }

    try {
        await rpcClient.getCurrentLedger();
        rpcCheckCache = { ok: true, checkedAt: Date.now() };
    } catch (e: unknown) {
        rpcCheckCache = { ok: false, error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
    }
    return rpcCheckCache;
}

// ─── Application ─────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Optional bearer-token auth ─────────────────────────────────────────────
//
// When SOROKEEP_METRICS_TOKEN is set, every observability route requires a
// matching `Authorization: Bearer <token>` header. Unset (the default)
// leaves these routes open — they're intended for localhost/private-network
// use unless a token is explicitly configured. A mismatch or missing header
// gets a bare 401 with no body, so nothing about the expected token leaks.
app.use("*", async (c, next) => {
    const requiredToken = process.env["SOROKEEP_METRICS_TOKEN"];
    if (requiredToken && requiredToken.trim() !== "") {
        if (c.req.header("authorization") !== `Bearer ${requiredToken}`) {
            return c.body(null, 401);
        }
    }
    return next();
});

app.get("/metrics", async (c) => {
    // Recompute every DB-backed metric from the live database on every
    // scrape — no caching layer, so readings always reflect the most
    // recent monitor cycle.
    if (activeDb) collectAllMetrics(activeDb);

    const body = await register.metrics();
    return c.text(body, 200, {
        "Content-Type": "text/plain; version=0.0.4",
    });
});

/**
 * Readiness check — distinct from liveness: can this instance actually do
 * useful work right now (reach the database and the configured Stellar RPC
 * endpoint), not just "is the process running."
 */
app.get("/readyz", async (c) => {
    const dbResult = activeDb ? checkDb(activeDb) : { ok: false, error: "no database configured" };
    const rpcResult = await checkRpc(activeRpcClient);
    const allOk = dbResult.ok && rpcResult.ok;

    return c.json(
        {
            status: allOk ? "ok" : "not ready",
            checks: {
                db: dbResult.ok ? "ok" : dbResult.error,
                rpc: rpcResult.ok ? "ok" : rpcResult.error,
            },
        },
        allOk ? 200 : 503,
    );
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the Prometheus metrics HTTP server on the given port.
 *
 * If a server is already running it is stopped first (replaced with a
 * fresh instance).  The server runs independently of the daemon cycle
 * — it does not block or affect the monitoring loop's timer.
 *
 * @param port TCP port to listen on.
 * @param db Optional database handle. When provided, every DB-backed
 *   metric is recomputed from the live database on each scrape, and
 *   /readyz's DB check uses it.
 * @param rpcClient Optional Stellar RPC client. When provided, /readyz's
 *   RPC check uses it (a lightweight, cached getCurrentLedger() call).
 * @param allowedIps Optional CIDR-aware IP allowlist (issue #427). When set,
 *   requests from any other remote address get a bare 403 before the Hono
 *   bridge even runs. Unset preserves today's open behavior.
 */
export function createMetricsServer(
    port: number,
    db?: Database.Database,
    rpcClient?: StellarRpcClient,
    allowedIps?: string[],
): void {
    // Replace any existing server so the caller gets a clean restart.
    if (activeServer) {
        activeServer.close();
        activeServer = null;
    }
    activeDb = db ?? null;
    activeRpcClient = rpcClient ?? null;
    rpcCheckCache = null;

    const isIpAllowed = allowedIps ? checkIpAllowlist(allowedIps) : null;
    let hasWarnedOpenAccess = false;

    const server = http.createServer((_req, res) => {
        // ── IP allowlist gate (issue #427) — real enforcement, checked
        // against the actual TCP remote address before anything else runs.
        if (isIpAllowed) {
            const remoteAddress = _req.socket.remoteAddress;
            if (!isIpAllowed(remoteAddress)) {
                ipAllowlistLogger.warn(`Blocked request from unauthorized IP: ${remoteAddress ?? "unknown"}`);
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
                return;
            }
        } else if (!hasWarnedOpenAccess) {
            ipAllowlistLogger.warn(
                "allowedIps is not configured — the observability HTTP server accepts requests from any address that can reach it.",
            );
            hasWarnedOpenAccess = true;
        }

        // Bridge the Node.js IncomingMessage → Hono Request → Node.js ServerResponse
        const chunks: Buffer[] = [];
        _req.on("data", (chunk: Buffer) => chunks.push(chunk));
        _req.on("end", async () => {
            try {
                // Build a Fetch API Request from the Node.js request
                const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
                const url = `http://${_req.headers.host ?? "localhost"}${_req.url}`;
                const method = _req.method ?? "GET";
                const headers = new Headers();
                for (const [key, value] of Object.entries(_req.headers)) {
                    if (value !== undefined) {
                        if (Array.isArray(value)) {
                            for (const v of value) headers.append(key, v);
                        } else {
                            headers.set(key, value);
                        }
                    }
                }

                const request = new Request(url, {
                    method,
                    headers,
                    body: body?.length ? body : undefined,
                });

                // Dispatch to Hono
                const honoResponse = await app.fetch(request);

                // Write the Hono Response back to the Node.js ServerResponse
                const status = honoResponse.status;
                const responseHeaders: Record<string, string | string[]> = {};
                honoResponse.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });

                res.writeHead(status, responseHeaders);

                if (honoResponse.body) {
                    const reader = honoResponse.body.getReader();
                    const pump = async () => {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                res.end();
                                return;
                            }
                            res.write(value);
                        }
                    };
                    await pump();
                } else {
                    res.end();
                }
            } catch {
                // If the Hono router or a handler throws, respond 500 rather
                // than letting the Node.js server crash on an unhandled rejection.
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "text/plain" });
                }
                res.end();
            }
        });
    });

    server.listen(port, "127.0.0.1");
    activeServer = server;
}

/**
 * Stop the metrics HTTP server gracefully.
 *
 * Idempotent — safe to call when no server is running.
 */
export async function stopMetricsServer(): Promise<void> {
    if (!activeServer) return;

    return new Promise<void>((resolve) => {
        // Force-close all idle connections to ensure the port is fully
        // released before the callback resolves.  This prevents "socket
        // hang up" when a new server binds the same port immediately after.
        activeServer!.closeIdleConnections();
        activeServer!.close(() => {
            activeServer = null;
            activeDb = null;
            activeRpcClient = null;
            rpcCheckCache = null;
            resolve();
        });
    });
}
