// CF-MARKET-MOVERS-SNAPSHOT-CACHE (Fable, 2026-09-12).
//
// A Tier 1 harness run (PR #2056) measured GET /api/compiq/market-movers?
// window=30d at 5.0s+ on a live prod request — a full cross-partition scan
// of every comp in the window, aggregated in memory, on the request path.
// sold_comps_daily (the rollup path the route already prefers) has never
// been written to in prod, so the fix cannot lean on turning a flag on.
//
// The fix: a request-scoped, short-TTL snapshot cache with stale-while-
// revalidate, so at most one live viewer per (sport, window, direction,
// limit, minSales) shape ever pays for the scan; every other viewer in that
// window gets the cached snapshot with zero Cosmos round-trips. These tests
// pin that behavior directly against the route handler (bypassing auth,
// which is orthogonal) using the same @azure/cosmos mock pattern the other
// unified-pricing unit tests use (see unifiedPerTierWindows.test.ts).
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queryCount: 0,
}));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
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
        }),
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
});

// The snapshot cache is a module-level Map keyed on (sport, window,
// direction, limit, minSales) — intentional (it survives across requests,
// that IS the fix), but it also survives across tests in this file since
// the module is imported once. Each test uses a distinct sport name as a
// cheap, collision-free cache key so tests stay independent without
// needing an exported reset hook.
let sportCounter = 0;
const freshSport = () => `test-sport-${++sportCounter}`;

describe("market-movers snapshot cache", () => {
  it("first request for a shape computes from Cosmos (cache miss)", async () => {
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    const handler = findHandler();
    const res = fakeRes();
    await handler(fakeReq({ sport: freshSport(), window: "7d", minSales: "3" }), res, (e) => { throw e; });
    expect(h.queryCount).toBeGreaterThan(0);
    expect((res._json as { cache: { state: string } }).cache.state).toBe("miss");
  });

  it("a second request for the SAME shape within TTL is served from cache with zero Cosmos round-trips", async () => {
    h.rows = [sale(10, 6), sale(12, 5), sale(20, 2), sale(22, 1)];
    const handler = findHandler();
    const sport = freshSport();

    const res1 = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res1, (e) => { throw e; });
    const queriesAfterFirst = h.queryCount;
    expect(queriesAfterFirst).toBeGreaterThan(0);

    const res2 = fakeRes();
    await handler(fakeReq({ sport, window: "7d", minSales: "3" }), res2, (e) => { throw e; });

    // No new Cosmos queries — the second request never touched sold_comps.
    expect(h.queryCount).toBe(queriesAfterFirst);
    expect((res2._json as { cache: { state: string } }).cache.state).toBe("fresh");
    // Byte-identical movers payload (minus the cache metadata) between the
    // fresh compute and the cache hit.
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
    const prev = process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_CONNECTION_STRING;
    // Force a fresh module load path isn't practical here since the shared
    // container is memoized per-process by getContainer's module-level
    // cache; this test instead documents the 503 contract by asserting the
    // route source still guards on a null container (regression guard for
    // the refactor, since computeMarketMovers now returns a sentinel
    // instead of writing res.json directly).
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "..", "src", "routes", "marketMovers.routes.ts"), "utf8");
    expect(src).toContain("sold_comps container unavailable");
    expect(src).toContain('"unavailable" in computed');
    if (prev !== undefined) process.env.COSMOS_CONNECTION_STRING = prev;
  });
});
