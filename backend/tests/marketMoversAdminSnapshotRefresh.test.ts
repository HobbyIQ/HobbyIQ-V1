// CF-MARKET-MOVERS-PERSISTED-SNAPSHOT (Fable, 2026-09-12).
//
// Pins the admin dispatch+poll surface (marketMoversAdmin.routes.ts) and
// the scheduled refresh job (refreshAllScheduledSnapshots) that
// "Daily Market Signals Refresh" calls via poll-admin-job.cjs. Same
// longJobTracker contract as the other long-cron lanes (see
// longCronsDoNotDieAtTheIdleCut.test.ts): a dispatch answers immediately
// with a jobId, and the run settles in the background where a later poll
// can read it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import * as longJobs from "../src/services/ops/longJobTracker.js";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queryCount: 0,
  concurrentQueries: 0,
  maxConcurrentQueries: 0,
  snapshots: new Map<string, Record<string, unknown>>(),
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
                h.concurrentQueries++;
                h.maxConcurrentQueries = Math.max(h.maxConcurrentQueries, h.concurrentQueries);
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => {
                    // Yield so overlapping callers would show up in
                    // maxConcurrentQueries if the refresh ever ran shapes
                    // concurrently instead of sequentially.
                    await new Promise((r) => setTimeout(r, 2));
                    done = true;
                    h.concurrentQueries--;
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

import marketMoversAdminRouter from "../src/routes/marketMoversAdmin.routes.js";
import {
  refreshAllScheduledSnapshots,
  scheduledSnapshotShapes,
  SCHEDULED_SNAPSHOT_SPORTS,
  SCHEDULED_SNAPSHOT_WINDOWS,
  SCHEDULED_SNAPSHOT_MIN_SALES,
} from "../src/services/compiq/marketMoversSnapshot.service.js";

function findHandler(path: string, method: "get" | "post"): (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void> }> } };
  const stack = (marketMoversAdminRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeReq(query: Record<string, string> = {}): Request {
  return { query, headers: {} } as unknown as Request;
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

beforeEach(() => {
  h.rows = [];
  h.queryCount = 0;
  h.concurrentQueries = 0;
  h.maxConcurrentQueries = 0;
  h.snapshots.clear();
  longJobs.__resetForTests();
});

describe("scheduledSnapshotShapes — bounded, not a combinatorial sweep", () => {
  it("is exactly sports × windows × minSales values, at direction=both with the route's own default limit", () => {
    // CF-SNAPSHOT-MISS-INCIDENT (2026-09-12): minSales now covers both 1
    // (the Tier 1 harness's own request, and the honest floor "any sale
    // counts") and 3 (the route's own default) — the coverage gap that let
    // a harness request fall through to an unbounded live scan.
    const shapes = scheduledSnapshotShapes();
    expect(shapes.length).toBe(
      SCHEDULED_SNAPSHOT_SPORTS.length * SCHEDULED_SNAPSHOT_WINDOWS.length * SCHEDULED_SNAPSHOT_MIN_SALES.length,
    );
    for (const s of shapes) {
      expect(s.direction).toBe("both");
      expect(s.limit).toBe(20);
      expect(SCHEDULED_SNAPSHOT_MIN_SALES).toContain(s.minSales);
    }
    // The exact shape the Tier 1 harness requests must be one of them.
    expect(shapes).toContainEqual({ sport: "baseball", windowDays: 30, direction: "both", limit: 20, minSales: 1 });
  });
});

describe("refreshAllScheduledSnapshots — sequential, not concurrent", () => {
  it("never has more than 1 sold_comps scan in flight at once", async () => {
    const summary = await refreshAllScheduledSnapshots();
    expect(summary.shapes).toBe(scheduledSnapshotShapes().length);
    expect(summary.succeeded).toBe(summary.shapes);
    expect(summary.failed).toBe(0);
    // The whole point: refreshing N shapes must not fan out N concurrent
    // cross-partition scans against the same RU-constrained container —
    // the exact mistake the ladder concurrency fix elsewhere in this PR
    // had to walk back under fleet load.
    expect(h.maxConcurrentQueries).toBe(1);
    expect(h.queryCount).toBeGreaterThanOrEqual(summary.shapes);
  });

  it("persists a readable snapshot per shape", async () => {
    await refreshAllScheduledSnapshots();
    expect(h.snapshots.size).toBe(scheduledSnapshotShapes().length);
    for (const doc of h.snapshots.values()) {
      expect(doc.type).toBe("market-movers");
      expect(doc.docType).toBe("market_movers_snapshot");
    }
  });
});

describe("admin dispatch + poll surface", () => {
  it("dispatch answers immediately with a jobId, before the refresh settles", async () => {
    h.rows = [];
    const dispatch = findHandler("/admin/market-movers/refresh-snapshots", "post");
    const res = fakeRes();
    const t0 = Date.now();
    dispatch(fakeReq(), res, (e) => { throw e; });
    // dispatch() is synchronous up to the 202 — the work runs in the
    // background (longJobs.dispatch's whole contract).
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(50);
    const body = res._json as { success: boolean; accepted: boolean; status: string; jobId: string };
    expect(body.success).toBe(true);
    expect(body.accepted).toBe(true);
    expect(body.status).toBe("running");
    expect(body.jobId).toBeTruthy();

    await longJobs.__awaitSettledForTests("market-movers-snapshot-refresh", "all-scheduled-shapes", 20_000);

    const status = findHandler("/admin/market-movers/refresh-snapshots/status", "get");
    const statusRes = fakeRes();
    status(fakeReq({ jobId: body.jobId }), statusRes, (e) => { throw e; });
    const statusBody = statusRes._json as { success: boolean; status: string; settled: boolean; result: { shapes: number } };
    expect(statusBody.success).toBe(true);
    expect(statusBody.status).toBe("done");
    expect(statusBody.settled).toBe(true);
    expect(statusBody.result.shapes).toBe(scheduledSnapshotShapes().length);
  });

  it("a jobId this worker never issued answers unknown-here, never a settled verdict", () => {
    const status = findHandler("/admin/market-movers/refresh-snapshots/status", "get");
    const res = fakeRes();
    status(fakeReq({ jobId: "not-a-real-job-id" }), res, (e) => { throw e; });
    const body = res._json as { status: string; settled: boolean };
    expect(body.status).toBe("unknown-here");
    expect(body.settled).toBe(false);
  });

  it("a second dispatch while one is running adopts it rather than starting a rival refresh", async () => {
    const dispatch = findHandler("/admin/market-movers/refresh-snapshots", "post");
    const res1 = fakeRes();
    dispatch(fakeReq(), res1, (e) => { throw e; });
    const res2 = fakeRes();
    dispatch(fakeReq(), res2, (e) => { throw e; });

    const body1 = res1._json as { jobId: string; alreadyRunning: boolean };
    const body2 = res2._json as { jobId: string; alreadyRunning: boolean };
    expect(body1.alreadyRunning).toBe(false);
    expect(body2.alreadyRunning).toBe(true);
    expect(body2.jobId).toBe(body1.jobId);

    await longJobs.__awaitSettledForTests("market-movers-snapshot-refresh", "all-scheduled-shapes", 20_000);
  });
});
