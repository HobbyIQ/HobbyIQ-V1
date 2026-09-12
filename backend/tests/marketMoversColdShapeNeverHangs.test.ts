// CF-COLD-SHAPE-NEVER-HANGS (2026-09-12).
//
// Post-deploy incident: prod c78e2cb had #2061 (persisted-snapshot route
// read) and #2076 (workflow step independence) live, and the "Daily Market
// Signals Refresh" dispatch DID write 12 snapshot docs to daily_snapshots
// (4 sports x 7/14/30d, minSales=3). Yet the Tier 1 harness's market-movers
// case (sport=baseball&window=30d&direction=both&limit=20&minSales=1)
// still timed out at 25,002ms.
//
// Root cause (confirmed read-only against prod): a SHAPE-COVERAGE gap, not
// a bug in the read order. The harness sends minSales=1; the scheduled job
// only ever wrote minSales=3 docs. readMarketMoversSnapshot's point read
// for market-movers::baseball::30::both::20::1 genuinely 404s in ~50-90ms
// (confirmed directly against prod) — the route correctly falls through to
// its "cold shape" branch, which is where the live, UNBOUNDED raw scan (the
// original #2057 finding) still lived. minSales=3's doc, by contrast,
// point-reads in ~40ms and is fresh (computedAt ~14:40-14:45Z).
//
// Two-part fix:
//   1. scheduledSnapshotShapes() now covers minSales in [1, 3], closing
//      the specific gap that caused this incident.
//   2. computeMarketMoversBounded wraps the live-scan fallback in a hard
//      wall-clock ceiling, so ANY future shape drift (a different limit,
//      direction, or minSales the schedule doesn't cover) degrades to a
//      bounded, honestly-labelled response instead of repeating the same
//      unbounded hang under a different combination of query params.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  neverResolve: false,
  /** Finite artificial delay (ms) on every sold_comps query — used to model
   *  a scan slower than the bounded budget but which DOES eventually
   *  finish, so the write-behind-on-timeout behavior can be observed. */
  queryDelayMs: 0,
  snapshots: new Map<string, Record<string, unknown>>(),
  queryCount: 0,
}));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: (id: string) => {
          if (id === "daily_snapshots") {
            return {
              items: {
                upsert: async (doc: Record<string, unknown>) => {
                  h.snapshots.set(String(doc.id), doc);
                  return { resource: doc };
                },
              },
              item: (docId: string) => ({
                read: async () => {
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
          return {
            items: {
              query: () => {
                h.queryCount++;
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => {
                    if (h.neverResolve) {
                      await new Promise(() => {}); // simulates a hung/throttled scan
                    }
                    if (h.queryDelayMs > 0) {
                      await new Promise((r) => setTimeout(r, h.queryDelayMs));
                    }
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

import {
  computeMarketMoversBounded,
  scheduledSnapshotShapes,
  type MarketMoversParams,
} from "../src/services/compiq/marketMoversSnapshot.service.js";

beforeEach(() => {
  h.rows = [];
  h.neverResolve = false;
  h.queryDelayMs = 0;
  h.snapshots.clear();
  h.queryCount = 0;
});

const HARNESS_SHAPE: MarketMoversParams = {
  sport: "baseball", windowDays: 30, direction: "both", limit: 20, minSales: 1,
};

describe("scheduledSnapshotShapes includes the exact harness request shape", () => {
  it("covers sport=baseball window=30d minSales=1 — the shape that caused the incident", () => {
    const shapes = scheduledSnapshotShapes();
    expect(shapes).toContainEqual(HARNESS_SHAPE);
  });
});

describe("computeMarketMoversBounded — a hung scan degrades honestly instead of hanging", () => {
  it("returns a bounded, labelled 200-shaped result when the live scan does not finish in time", async () => {
    h.neverResolve = true;
    const started = Date.now();
    const outcome = await computeMarketMoversBounded(HARNESS_SHAPE, 100);
    const elapsed = Date.now() - started;

    if ("unavailable" in outcome) throw new Error("expected a bounded outcome, not unavailable");
    expect(outcome.timedOut).toBe(true);
    // Bounded to roughly the configured ceiling, not the real prod default
    // (8s) and nowhere near the harness's own 25s ceiling.
    expect(elapsed).toBeLessThan(2_000);
    // Still a well-shaped, honest response — empty movers, never null,
    // never a partial/invented result.
    expect(outcome.result.sport).toBe("baseball");
    expect(outcome.result.windowDays).toBe(30);
    expect(Array.isArray(outcome.result.movers)).toBe(true);
    expect(outcome.result.movers.length).toBe(0);
    expect(typeof outcome.result.computedAt).toBe("string");
  });

  it("a fast scan (no delay) returns the real computed result, not the placeholder", async () => {
    h.rows = [
      { cardId: "hiq:baseball:2024:topps:1:base:no-auto", playerName: "Test", setName: "Topps", parallel: null, cardNumber: "1", cardYear: 2024, gradeCompany: null, gradeValue: null, price: 10, soldAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), imageUrl: null, title: null },
      { cardId: "hiq:baseball:2024:topps:1:base:no-auto", playerName: "Test", setName: "Topps", parallel: null, cardNumber: "1", cardYear: 2024, gradeCompany: null, gradeValue: null, price: 20, soldAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), imageUrl: null, title: null },
    ];
    const outcome = await computeMarketMoversBounded(HARNESS_SHAPE);
    if ("unavailable" in outcome) throw new Error("expected a bounded outcome, not unavailable");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.result.totalSkusInWindow).toBeGreaterThan(0);
  });

  it("a timed-out compute that finishes shortly after still persists a snapshot for the next request", async () => {
    // A short budget (30ms) races against a compute slower than that but
    // which DOES finish (60ms) — models a scan that is briefly slower than
    // this request's patience without being genuinely hung. The caller
    // gets the bounded timeout response; the compute is not abandoned.
    h.queryDelayMs = 60;
    h.rows = [
      { cardId: "hiq:baseball:2024:topps:1:base:no-auto", playerName: "Test", setName: "Topps", parallel: null, cardNumber: "1", cardYear: 2024, gradeCompany: null, gradeValue: null, price: 10, soldAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), imageUrl: null, title: null },
      { cardId: "hiq:baseball:2024:topps:1:base:no-auto", playerName: "Test", setName: "Topps", parallel: null, cardNumber: "1", cardYear: 2024, gradeCompany: null, gradeValue: null, price: 20, soldAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), imageUrl: null, title: null },
    ];
    const outcome = await computeMarketMoversBounded(HARNESS_SHAPE, 30);
    if ("unavailable" in outcome) throw new Error("expected a bounded outcome");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.result.movers.length).toBe(0);

    // The background compute is still running — give it time to finish
    // and write its snapshot.
    await new Promise((r) => setTimeout(r, 150));
    const written = h.snapshots.get("market-movers::baseball::30::both::20::1");
    expect(written).toBeTruthy();
    expect((written as { result: { totalSkusInWindow: number } }).result.totalSkusInWindow).toBeGreaterThan(0);
  }, 5_000);
});
