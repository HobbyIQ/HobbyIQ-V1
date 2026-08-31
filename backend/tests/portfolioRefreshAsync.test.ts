/**
 * CF-PORTFOLIO-REFRESH-ASYNC (Drew, 2026-08-31)
 *
 * The portfolio refresh used to block on the full valuation chain. Measured
 * in App Insights, one POST /api/portfolio/reprice/batch issued 5,657 Cosmos
 * dependency calls totalling 68.3s (2,992 sold_comps, 1,895 card_catalog,
 * 280 daily_price_series) and never recorded a completed request row — the
 * client aborted first.
 *
 * These tests pin the two properties that fix depends on:
 *   1. the dispatch answers WITHOUT waiting for the pricing work, and
 *   2. the read path tells the caller the values may be superseded.
 *
 * They exercise the job tracker and the freshness envelope directly — the
 * pieces that carry the new behaviour — rather than standing up Cosmos.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as tracker from "../src/services/portfolioiq/repriceJobTracker.js";

describe("repriceJobTracker — dispatch bookkeeping", () => {
  beforeEach(() => tracker.__resetForTests());

  it("reports no run for a user who never dispatched one", () => {
    expect(tracker.isRunning("user-a")).toBe(false);
    expect(tracker.getJob("user-a")).toBeNull();
  });

  it("marks a dispatched run as running", () => {
    tracker.markStarted("user-a");
    expect(tracker.isRunning("user-a")).toBe(true);
    expect(tracker.getJob("user-a")?.status).toBe("running");
  });

  it("keeps users independent — one run does not mark another user busy", () => {
    tracker.markStarted("user-a");
    expect(tracker.isRunning("user-b")).toBe(false);
  });

  it("settles to done and carries the result through", () => {
    tracker.markStarted("user-a");
    tracker.markDone("user-a", {
      requested: 4,
      repriced: 3,
      skipped: 1,
      updates: [],
    } as any);
    const job = tracker.getJob("user-a");
    expect(job?.status).toBe("done");
    expect(job?.result?.repriced).toBe(3);
    expect(tracker.isRunning("user-a")).toBe(false);
  });

  it("settles to error and carries the message", () => {
    tracker.markStarted("user-a");
    tracker.markError("user-a", "cosmos exploded");
    expect(tracker.getJob("user-a")?.status).toBe("error");
    expect(tracker.getJob("user-a")?.error).toBe("cosmos exploded");
    expect(tracker.isRunning("user-a")).toBe(false);
  });

  it("treats a long-dead run as not-running so a killed process cannot wedge a user out of refreshing", () => {
    const t0 = 1_000_000;
    tracker.markStarted("user-a", t0);
    // Still in flight a minute in — the measured worst case was ~68s.
    expect(tracker.isRunning("user-a", t0 + 60_000)).toBe(true);
    // Eleven minutes on, nothing settled it: assume the process died.
    expect(tracker.isRunning("user-a", t0 + 11 * 60_000)).toBe(false);
  });

  it("sweeps settled entries once their retention window passes", () => {
    const t0 = 1_000_000;
    tracker.markStarted("user-a", t0);
    tracker.markDone("user-a", { requested: 0, repriced: 0, skipped: 0, updates: [] } as any, t0);
    expect(tracker.getJob("user-a")).not.toBeNull();
    tracker.sweep(t0 + 11 * 60_000);
    expect(tracker.getJob("user-a")).toBeNull();
  });

  it("does not sweep a run that is still in flight", () => {
    const t0 = 1_000_000;
    tracker.markStarted("user-a", t0);
    tracker.sweep(t0 + 11 * 60_000);
    expect(tracker.getJob("user-a")).not.toBeNull();
  });
});

describe("buildValuationFreshness — the read never claims to be fresher than it is", () => {
  beforeEach(() => tracker.__resetForTests());

  // Imported lazily: portfolioStore.service pulls in the Cosmos client at
  // module load, so keep it out of the tracker-only describe above.
  const load = async () =>
    (await import("../src/services/portfolioiq/portfolioStore.service.js")).buildValuationFreshness;

  it("reports the stalest holding's timestamp, not the freshest", async () => {
    const buildValuationFreshness = await load();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const out = buildValuationFreshness(
      "user-a",
      [
        { lastUpdated: "2026-08-31T11:59:00.000Z" },
        { lastUpdated: "2026-08-30T12:00:00.000Z" }, // the stale one
        { lastUpdated: "2026-08-31T11:00:00.000Z" },
      ] as any,
      now,
    );
    expect(out.oldestValuationAt).toBe("2026-08-30T12:00:00.000Z");
    expect(out.oldestValuationAgeMs).toBe(24 * 60 * 60 * 1000);
  });

  it("flags repricing while a run for THAT user is in flight", async () => {
    const buildValuationFreshness = await load();
    const now = Date.now();
    expect(buildValuationFreshness("user-a", [] as any, now).repricing).toBe(false);
    tracker.markStarted("user-a", now);
    expect(buildValuationFreshness("user-a", [] as any, now).repricing).toBe(true);
    // Another user's read is unaffected.
    expect(buildValuationFreshness("user-b", [] as any, now).repricing).toBe(false);
  });

  it("returns nulls rather than a bogus timestamp when nothing has a lastUpdated", async () => {
    const buildValuationFreshness = await load();
    const out = buildValuationFreshness(
      "user-a",
      [{}, { lastUpdated: null }, { lastUpdated: "not-a-date" }] as any,
      Date.now(),
    );
    expect(out.oldestValuationAt).toBeNull();
    expect(out.oldestValuationAgeMs).toBeNull();
  });

  it("accepts epoch-millis lastUpdated as well as ISO strings", async () => {
    const buildValuationFreshness = await load();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const out = buildValuationFreshness(
      "user-a",
      [{ lastUpdated: Date.parse("2026-08-31T10:00:00.000Z") }] as any,
      now,
    );
    expect(out.oldestValuationAgeMs).toBe(2 * 60 * 60 * 1000);
  });

  it("never reports a negative age when a holding's clock is ahead", async () => {
    const buildValuationFreshness = await load();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const out = buildValuationFreshness(
      "user-a",
      [{ lastUpdated: "2026-08-31T12:05:00.000Z" }] as any,
      now,
    );
    expect(out.oldestValuationAgeMs).toBe(0);
  });
});
