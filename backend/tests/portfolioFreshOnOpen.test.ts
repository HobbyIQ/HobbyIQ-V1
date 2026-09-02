/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02)
 *
 * "when going to the portfolio, seems like the cache pricing is there, it
 * needs to be fresh each time."
 *
 * Opening the portfolio now dispatches a reprice for that user. That changes
 * the throttle from a nicety into load-bearing infrastructure: the guard is
 * no longer protecting against a user mashing a button, it is the only thing
 * between "Drew opens the tab twice" and two concurrent 68s valuation runs
 * (5,657 Cosmos calls apiece, measured).
 *
 * The failure mode these tests exist for is specific. `_lastRepriceAt` is a
 * per-process Map and App Insights shows 2 serving instances, so open #2
 * round-robins onto the worker that has never heard of this user, finds an
 * empty map, and starts a rival run. That is the in-process-lock caveat
 * pointed the other way: the absence of shared state lets work THROUGH
 * rather than blocking it. The fix is a durable marker on the user doc, and
 * `evaluateRepriceThrottle` is the decision made pure so both the
 * same-worker and cross-worker cases can be pinned without standing up two
 * Node processes or Cosmos.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateRepriceThrottle,
  buildValuationFreshness,
} from "../src/services/portfolioiq/portfolioStore.service.js";

const MIN = 60_000;
const THROTTLE = 5 * MIN;

describe("evaluateRepriceThrottle — two opens a minute apart is ONE reprice", () => {
  it("throttles the second open when the first ran on THIS worker", () => {
    const t0 = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: t0,
      persistedAt: null,
      throttleMs: THROTTLE,
      now: t0 + MIN,
    });
    expect(d.throttled).toBe(true);
    expect(d.retryAfterMs).toBe(4 * MIN);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. Open #1 dispatched on worker A and
   * stamped the durable marker; open #2 load-balanced to worker B, whose
   * in-process map is empty. Before the persisted marker, worker B saw
   * `undefined` and started a second full valuation run over the same
   * holdings — two writers racing on one doc, last-write-wins.
   */
  it("throttles an open on a worker that never saw the first run", () => {
    const t0 = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: null, // worker B knows nothing
      persistedAt: t0, // but the user doc remembers
      throttleMs: THROTTLE,
      now: t0 + MIN,
    });
    expect(d.throttled).toBe(true);
    expect(d.retryAfterMs).toBe(4 * MIN);
  });

  it("lets a genuinely stale open through once the window passes", () => {
    const t0 = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: t0,
      persistedAt: t0,
      throttleMs: THROTTLE,
      now: t0 + THROTTLE + 1,
    });
    expect(d.throttled).toBe(false);
    expect(d.retryAfterMs).toBe(0);
  });

  it("takes the MORE RECENT of the two markers, never the older one", () => {
    const t0 = 1_000_000;
    // In-process is stale (last completed run), persisted is fresh (a
    // dispatch 30s ago on the other instance). Using the older marker would
    // wave the duplicate run through.
    const d = evaluateRepriceThrottle({
      inProcessAt: t0,
      persistedAt: t0 + 4 * MIN + 30_000,
      throttleMs: THROTTLE,
      now: t0 + 4 * MIN + 60_000,
    });
    expect(d.throttled).toBe(true);
  });

  it("reports the timestamp it decided against, so the skip can say fresh-as-of", () => {
    const t0 = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: null,
      persistedAt: t0,
      throttleMs: THROTTLE,
      now: t0 + MIN,
    });
    // A skip that says only "throttled" is indistinguishable from a broken
    // refresh. The caller must be able to tell the user how current the
    // values on screen actually are.
    expect(d.lastAt).toBe(t0);
  });

  it("does not throttle a user who has never been repriced", () => {
    const d = evaluateRepriceThrottle({
      inProcessAt: null,
      persistedAt: null,
      throttleMs: THROTTLE,
      now: 1_000_000,
    });
    expect(d.throttled).toBe(false);
    expect(d.lastAt).toBeNull();
  });

  it("cannot be wedged shut by a future-dated marker from a skewed instance", () => {
    // Two instances, two clocks. A marker from the future must not lock a
    // user out of refreshing until real time catches up.
    const now = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: null,
      persistedAt: now + 10 * MIN,
      throttleMs: THROTTLE,
      now,
    });
    expect(d.throttled).toBe(false);
  });

  it("treats a zero throttle as disabled rather than as always-throttled", () => {
    const t0 = 1_000_000;
    const d = evaluateRepriceThrottle({
      inProcessAt: t0,
      persistedAt: t0,
      throttleMs: 0,
      now: t0 + 1,
    });
    expect(d.throttled).toBe(false);
  });
});

describe("buildValuationFreshness — the read reports age, never a price", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("reports both ends: the freshest row for 'as of', the stalest for 'is anything old'", () => {
    const now = 2_000_000_000;
    const v = buildValuationFreshness(
      "user-fresh-open",
      [
        { lastUpdated: iso(now - 10 * MIN) },
        { lastUpdated: iso(now - 6 * 60 * MIN) },
        { lastUpdated: iso(now - 2 * MIN) },
      ] as any,
      now,
    );
    expect(v.newestValuationAt).toBe(iso(now - 2 * MIN));
    expect(v.oldestValuationAt).toBe(iso(now - 6 * 60 * MIN));
    // Neither is derived from the other, and neither is a price.
    expect(v.oldestValuationAgeMs).toBe(6 * 60 * MIN);
  });

  it("surfaces the durable dispatch marker so freshness survives the worker split", () => {
    const now = 2_000_000_000;
    const dispatched = now - 30_000;
    const v = buildValuationFreshness(
      "user-fresh-open",
      [{ lastUpdated: iso(now - MIN) }] as any,
      now,
      dispatched,
    );
    // `repricing` is per-worker and reads false on the instance that did not
    // dispatch; this marker is the fact both workers agree on.
    expect(v.lastRepriceDispatchAt).toBe(iso(dispatched));
  });

  it("says nothing rather than inventing freshness when no holding has a timestamp", () => {
    const v = buildValuationFreshness("user-fresh-open", [{}, {}] as any, 2_000_000_000);
    expect(v.newestValuationAt).toBeNull();
    expect(v.oldestValuationAt).toBeNull();
    expect(v.lastRepriceDispatchAt).toBeNull();
  });

  it("omits the dispatch marker when the user doc carries none", () => {
    const now = 2_000_000_000;
    const v = buildValuationFreshness(
      "user-fresh-open",
      [{ lastUpdated: iso(now) }] as any,
      now,
      null,
    );
    expect(v.lastRepriceDispatchAt).toBeNull();
  });
});

/**
 * THE ENDPOINT CONTRACT. The whole design rests on the list read staying
 * cheap: it serves stored values off one user doc in ~77ms, which is what
 * lets the page render instantly and refresh behind itself. If this ever
 * starts pricing, the on-open dispatch becomes a second copy of the
 * valuation path and the 68s cost moves back onto the render.
 */
describe("GET /api/portfolio contract — the list endpoint computes no price", () => {
  it("keeps the freshness envelope free of any price-bearing field", () => {
    const now = 2_000_000_000;
    const v = buildValuationFreshness(
      "user-fresh-open",
      [{ lastUpdated: new Date(now).toISOString(), fairMarketValue: 123.45 }] as any,
      now,
    );
    const keys = Object.keys(v).sort();
    expect(keys).toEqual([
      "lastRepriceDispatchAt",
      "newestValuationAt",
      "oldestValuationAgeMs",
      "oldestValuationAt",
      "repricing",
    ]);
    // Nothing in the envelope carries a dollar figure — it reports WHEN,
    // never WHAT. The holding's own fairMarketValue above is deliberately
    // ignored here.
    expect(JSON.stringify(v)).not.toContain("123.45");
  });
});
