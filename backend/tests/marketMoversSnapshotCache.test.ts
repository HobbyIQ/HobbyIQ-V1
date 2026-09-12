// CF-MARKET-MOVERS-PERSISTED-SNAPSHOT (Fable, 2026-09-12, revised same day).
//
// D1 (PR #2057) added an in-process, per-worker snapshot cache in front of
// the raw cross-partition scan. The post-deploy Tier 1 harness run found
// that alone doesn't fix the real deployment shape: HobbyIQ3 runs on 2 App
// Service instances and workers recycle every 8-19 minutes, so the first
// viewer of any shape on any worker after any recycle still pays for the
// scan — and under fleet load that scan can take >25s, not the quiet-pool
// 5s D1 was sized against.
//
// D2 (this revision) adds a PERSISTED snapshot in the existing
// daily_snapshots container (partition /type), refreshed on its own
// schedule by an admin job (see marketMoversAdminRoutes + the "Daily
// Market Signals Refresh" workflow), read via one Cosmos point read. The
// route's read order is now: in-process cache (fresh) -> persisted
// snapshot (one point read) -> live compute (only on a genuinely cold
// shape). These tests pin that order directly against the route handler
// (bypassing auth, which is orthogonal) using a Cosmos mock that models
// BOTH container shapes the route touches: sold_comps (cross-partition
// query, via computeMarketMovers) and daily_snapshots (point read/write,
// via readMarketMoversSnapshot).
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queryCount: 0,
  snapshots: new Map<string, Record<string, unknown>>(),
  snapshotReadCount: 0,
}));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        // Both sold_comps and daily_snapshots resolve through this same
        // factory — route by container id so each keeps its own shape.
        container: (id: string) => {
          if (id === "daily_snapshots") {
            return {
              items: {
                upsert: async (doc: Record<string, unknown>) => {
                  h.snapshots.set(String(doc.id), doc);
                  return { resource: doc };
                },
              },
              item: (docId: string, _pk: string) => ({
                read: async () => {
                  h.snapshotReadCount++;
                  const resource = h.snapshots.get(docId);
                  if (!resource) {
                    const err = new Error("NotFound") as Error & { code: number };
                    err.code = 404;
                    throw err;
                  }
                  return { resource };
                },
              }),
            };
          }
          // sold_comps (or sold_comps_daily): cross-partition query mock.
          return {
            items: {
              query: () => {
                h.queryCount++;
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => {
                    done = true;
                    return { resources: h.rows };
                  },
                };
              },
            },
          };
        },
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";

// requireSession is applied by the route but is orthogonal to the caching
// behavior under test — stub it to attach a fake user and call next().
vi.mock("../src/middleware/requireSession.js", () => ({
  requireSession: (req: Request, _res: Response, next: () => void) => {
    (req as unknown as { user: { userId: string } }).user = { userId: "test-user" };
    next();
  },
}));

import marketMoversRouter from "../src/routes/marketMovers.routes.js";
import { computeAndPersistMarketMoversSnapshot, type MarketMoversParams } from "../src/services/compiq/marketMoversSnapshot.service.js";

// Express Router() exposes its routes on .stack; pull the GET
// /market-movers handler out directly so the test can drive it without
// standing up a full HTTP server.
function findHandler(): (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void> {
  type Layer = { route?: { path: string; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void> }> } };
  const stack = (marketMoversRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === "/market-movers");
  if (!layer?.route) throw new Error("market-movers route not found");
  // Last middleware in the route's own stack is the handler (requireSession
  // runs first, mocked above to call next()).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeReq(query: Record<string, string> = {}): Request {
  return { query, user: { userId: "test-user" } } as unknown as Request;
}

function fakeRes(): Response & { _json: unknown; _status: number | null } {
  const res = {
    _json: null as unknown,
    _status: null as number | null,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._json = body; return this; },
  };
  return res as unknown as Response & { _json: unknown; _status: number | null };
}

const sale = (price: number, daysAgo: number, cardId = "hiq:baseball:2024:topps:1:base:no-auto") => ({
  cardId,
  playerName: "Test Player",
  setName: "Topps",
  parallel: null,
  cardNumber: "1",
  cardYear: 2024,
  gradeCompany: null,
  gradeValue: null,
  price,
  soldAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  imageUrl: null,
  title: null,
});

beforeEach(() => {
  h.rows = [];
  h.queryCount = 0;
  h.snapshots.clear();
  h.snapshotReadCount = 0;
});

// The in-process cache is a module-level Map keyed on (sport, window,
// direction, limit, minSales) — intentional (it survives across requests
// on the SAME worker), but it also survives across tests in this file
// since the module is imported once. Each test uses a distinct sport name
// as a cheap, collision-free cache key so tests stay independent without
// needing an exported reset hook.
let sportCounter = 0;
const freshSport = () => `test-sport-${++sportCounter}`;

describe("market-movers — persisted snapshot read order", () => {
  it("a cold shape (no snapshot, empty in-process cache) computes live from sold_comps", async () => {
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    const handler = findHandler();
    const res = fakeRes();
    await handler(fakeReq({ sport: freshSport(), window: "7d", minSales: "3" }), res, (e) => { throw e; });
    expect(h.queryCount).toBeGreaterThan(0);
    expect((res._json as { cache: { state: string } }).cache.state).toBe("miss");
  });

  it("a shape with a PERSISTED snapshot is served from one Cosmos point read — never the raw scan", async () => {
    const sport = freshSport();
    const shape: MarketMoversParams = { sport, windowDays: 7, direction: "both", limit: 20, minSales: 3 };
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    // Warm the snapshot the way the scheduled admin job would.
    const outcome = await computeAndPersistMarketMoversSnapshot(shape);
    if ("unavailable" in outcome) throw new Error("snapshot compute unavailable in test");
    expect(outcome.persisted).toBe(true);
    const queriesAfterWarm = h.queryCount;
    expect(queriesAfterWarm).toBeGreaterThan(0); // the warm itself did scan once

    // A live request for the SAME shape must NOT re-scan sold_comps — it
    // reads the persisted snapshot instead (one point read).
    const handler = findHandler();
    const res = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res, (e) => { throw e; });
    expect(h.queryCount).toBe(queriesAfterWarm); // no new sold_comps scan
    expect(h.snapshotReadCount).toBeGreaterThan(0);
    const body = res._json as { cache: { state: string }; movers: unknown[] };
    expect(body.cache.state).toBe("persisted-snapshot");
    expect(body.movers).toEqual(outcome.result.movers);
  });

  it("a second request for the SAME shape within the in-process TTL skips even the snapshot point read", async () => {
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    const handler = findHandler();
    const sport = freshSport();

    const res1 = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res1, (e) => { throw e; });
    const queriesAfterFirst = h.queryCount;
    const snapshotReadsAfterFirst = h.snapshotReadCount;

    const res2 = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res2, (e) => { throw e; });

    // No new Cosmos activity at all — served from the in-process cache.
    expect(h.queryCount).toBe(queriesAfterFirst);
    expect(h.snapshotReadCount).toBe(snapshotReadsAfterFirst);
    expect((res2._json as { cache: { state: string } }).cache.state).toBe("in-process");
    // Byte-identical movers payload (minus the cache metadata) between the
    // cold compute and the in-process cache hit.
    const { cache: _c1, ...body1 } = res1._json as Record<string, unknown>;
    const { cache: _c2, ...body2 } = res2._json as Record<string, unknown>;
    expect(body2).toEqual(body1);
  });

  it("a DIFFERENT query shape (different window) is its own cache key and re-queries Cosmos", async () => {
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    const handler = findHandler();
    const sport = freshSport();

    const res1 = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res1, (e) => { throw e; });
    const queriesAfterFirst = h.queryCount;

    const res2 = fakeRes();
    await handler(fakeReq({ sport, window: "30d", minSales: "3" }), res2, (e) => { throw e; });

    expect(h.queryCount).toBeGreaterThan(queriesAfterFirst);
    expect((res2._json as { cache: { state: string } }).cache.state).toBe("miss");
  });

  it("sold_comps unavailable still returns 503, not a thrown error", async () => {
    // Regression guard for the refactor: the route source still guards on
    // a null container from computeMarketMoversBounded's sentinel return
    // (CF-COLD-SHAPE-NEVER-HANGS renamed the cold-shape compute call).
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "..", "src", "routes", "marketMovers.routes.ts"), "utf8");
    expect(src).toContain("sold_comps container unavailable");
    expect(src).toContain('"unavailable" in bounded');
  });
});
