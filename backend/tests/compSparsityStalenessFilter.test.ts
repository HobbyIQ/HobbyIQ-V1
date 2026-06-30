// CF-COMP-SPARSITY-STALENESS-FILTER (2026-06-29) — pins the comp
// credibility filter on the rail's observed-detection path.
//
// Vol Test #2 (2026-06-29) surfaced the canonical case:
//   1959 Topps Willie Mays #50:
//     PSA 9  = $28,892 (12 supporting sales, fresh — 22d old)
//     PSA 10 = $1,692  (1 supporting sale, stale  — 224d old)
//   Engine pre-CF: PSA 10's single stale sale counts as "observed truth",
//     surfaces as $1,692 even though PSA 9 (more comps, fresher) is $28,892.
//   Engine post-CF: n=1 + stale (>180d) → NOT credibly observed → rail
//     fills PSA 10 via R-scaling off PSA 9 (the trusted neighbor) →
//     emits a credible vintage-HOF PSA 10 estimate instead of the outlier.
//
// We mirror CH's confidence_grade=C signaling internally (CH itself flagged
// the Mays PSA 10 as C-grade — single sale, stale). Filter logic is OUR
// engine's, not CH's product — we're heading toward eBay direct, so don't
// deepen the CH dependency, just learn from its approach.
//
// THIS FILE PINS:
//   1. filterCredibleObserved: n=0 → empty; n>=2 → kept; n=1+fresh → kept;
//      n=1+stale → empty; n=1+null-date → empty (defensive)
//   2. Boundary: exactly 180d → still credible (≤ threshold)
//   3. Boundary: 181d → not credible
//   4. Integration: Mays-shaped pricing → rail emits a PSA 10 result
//      (proving the gate flipped from "observed-skip" to "estimate")

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { filterCredibleObserved } from "../src/services/compiq/gradedPriceProjection.js";
import type { CardsightSaleRecord } from "../src/services/compiq/catalogSource.js";

const NOW = Date.parse("2026-06-29T00:00:00Z");
const DAY = 86_400_000;

function rec(daysAgo: number | null, price = 100): CardsightSaleRecord {
  const date = daysAgo == null
    ? null
    : new Date(NOW - daysAgo * DAY).toISOString();
  return {
    title: "test",
    price,
    date,
    source: "ebay",
    url: null,
    parallel_id: null,
  };
}

describe("CF-COMP-SPARSITY-STALENESS-FILTER — filterCredibleObserved", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("empty input → empty output", () => {
    expect(filterCredibleObserved([])).toEqual([]);
  });

  it("n=1, fresh (1d) → kept (singleton credible when recent)", () => {
    const r = [rec(1)];
    expect(filterCredibleObserved(r)).toHaveLength(1);
  });

  it("n=1, stale (224d, Mays-canonical) → empty (singleton not credible when ancient)", () => {
    const r = [rec(224)];
    expect(filterCredibleObserved(r)).toEqual([]);
  });

  it("n=1, exactly 180d → kept (boundary inclusive)", () => {
    const r = [rec(180)];
    expect(filterCredibleObserved(r)).toHaveLength(1);
  });

  it("n=1, exactly 181d → empty (one day past threshold)", () => {
    const r = [rec(181)];
    expect(filterCredibleObserved(r)).toEqual([]);
  });

  it("n=1, null date → empty (defensive: undated singleton is the case we most want to exclude)", () => {
    const r = [rec(null)];
    expect(filterCredibleObserved(r)).toEqual([]);
  });

  it("n=1, malformed date → empty", () => {
    const malformed = { ...rec(1), date: "not a date" };
    expect(filterCredibleObserved([malformed])).toEqual([]);
  });

  it("n=2, both stale (300d each) → kept (corroboration overrides staleness)", () => {
    const r = [rec(300, 100), rec(310, 105)];
    expect(filterCredibleObserved(r)).toHaveLength(2);
  });

  it("n=2, mixed fresh + stale → kept (n>=2 rule)", () => {
    const r = [rec(5, 100), rec(400, 90)];
    expect(filterCredibleObserved(r)).toHaveLength(2);
  });

  it("n=12, fresh (Mays PSA 9 control) → kept", () => {
    const r = Array.from({ length: 12 }, (_, i) => rec(20 + i, 28000 + i * 100));
    expect(filterCredibleObserved(r)).toHaveLength(12);
  });

  it("nowMs override: caller-provided clock (no fake-timers required)", () => {
    // Caller passes nowMs directly — proves the function is pure when given a clock.
    const r = [rec(0)]; // built with daysAgo=0 → date=NOW
    // Bump nowMs to NOW + 200d. The record is now 200d stale.
    expect(filterCredibleObserved(r, NOW + 200 * DAY)).toEqual([]);
    // Bump nowMs to NOW + 100d. Still fresh.
    expect(filterCredibleObserved(r, NOW + 100 * DAY)).toHaveLength(1);
  });
});
