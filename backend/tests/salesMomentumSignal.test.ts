// CF-CH-TREND-INGEST (2026-06-28) — pins deriveSalesMomentum's contract
// and the sales_momentum_observed telemetry shape.
//
// PRIOR-CF GAP: we had no player-level price-class momentum signal
// independent of our own compsMomentum (card-level). CardHedge's
// sales-stats-by-player gives us weekly count + avg_sale per player
// across the full catalog — when a player's avg_sale jumps relative
// to their prior 4 weeks, that's a cascade-tier shift even before any
// single card's comps move enough to fire compsMomentum.
//
// THIS FILE PINS:
//   1. Empty / short / all-partial buckets → empty signal
//   2. Latest complete week + 4 prior complete weeks → both ratios computed
//   3. Partial latest bucket is excluded from latest-week selection
//   4. Up to 4 prior weeks averaged when more are available
//   5. Ratios round to 3 decimal places
//   6. Zero prior mean → ratio null (no divide-by-zero)
//   7. Telemetry event SKIPPED when signal has no latest week

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveSalesMomentum,
  logSalesMomentumObserved,
  type SalesBucketLite,
} from "../src/services/compiq/compiqEstimate.service.js";

const baseBucket = (overrides: Partial<SalesBucketLite>): SalesBucketLite => ({
  start: "2026-01-01",
  end: "2026-01-07",
  count: 100,
  average_sale: 50,
  partial: false,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. EMPTY / DEGRADE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSalesMomentum — empty/degrade", () => {
  it("empty array → all-null signal", () => {
    const s = deriveSalesMomentum([]);
    expect(s.latestCompleteWeek).toBeNull();
    expect(s.momentumRatio).toBeNull();
    expect(s.volumeRatio).toBeNull();
  });

  it("single bucket → not enough data, all-null signal", () => {
    const s = deriveSalesMomentum([baseBucket({})]);
    expect(s.latestCompleteWeek).toBeNull();
  });

  it("only partial buckets → all-null", () => {
    const s = deriveSalesMomentum([
      baseBucket({ partial: true }),
      baseBucket({ partial: true }),
    ]);
    expect(s.latestCompleteWeek).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HAPPY PATH — both ratios computed
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSalesMomentum — happy path", () => {
  it("uses latest complete week + 4 prior complete weeks", () => {
    const s = deriveSalesMomentum([
      baseBucket({ start: "2026-05-04", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-11", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-18", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-25", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-06-01", count: 200, average_sale: 100 }), // latest
    ]);
    expect(s.latestCompleteWeek?.start).toBe("2026-06-01");
    expect(s.priorMeanAvgSale).toBe(50);
    expect(s.priorMeanCount).toBe(100);
    expect(s.priorWeeks).toBe(4);
    expect(s.momentumRatio).toBe(2); // 100/50
    expect(s.volumeRatio).toBe(2);   // 200/100
  });

  it("ignores partial latest bucket — uses the prior complete one as 'latest'", () => {
    const s = deriveSalesMomentum([
      baseBucket({ start: "2026-05-04", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-11", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-18", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-25", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-06-01", count: 200, average_sale: 100 }),
      baseBucket({ start: "2026-06-08", count: 999, average_sale: 999, partial: true }),
    ]);
    expect(s.latestCompleteWeek?.start).toBe("2026-06-01");
    expect(s.momentumRatio).toBe(2);
  });

  it("uses only the most recent 4 prior weeks when more are available", () => {
    // 7 prior weeks at $50, 1 prior week at $200 (far back), latest at $100.
    // Only the most-recent 4 priors should count → mean = 50 → ratio = 2.
    const s = deriveSalesMomentum([
      baseBucket({ start: "2026-04-06", count: 100, average_sale: 200 }), // outside 4-week window
      baseBucket({ start: "2026-04-13", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-04-20", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-04-27", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-04", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-11", count: 100, average_sale: 50 }), // last of 4 priors
      baseBucket({ start: "2026-05-18", count: 200, average_sale: 100 }), // latest
    ]);
    expect(s.priorWeeks).toBe(4);
    expect(s.priorMeanAvgSale).toBe(50);
    expect(s.momentumRatio).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DIVIDE-BY-ZERO / PRECISION
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSalesMomentum — guards", () => {
  it("prior mean of zero → ratios null (no divide-by-zero)", () => {
    const s = deriveSalesMomentum([
      baseBucket({ start: "2026-05-04", count: 0, average_sale: 0 }),
      baseBucket({ start: "2026-05-11", count: 100, average_sale: 50 }),
    ]);
    expect(s.momentumRatio).toBeNull();
    expect(s.volumeRatio).toBeNull();
  });

  it("ratios round to 3 decimals", () => {
    const s = deriveSalesMomentum([
      baseBucket({ start: "2026-05-04", count: 100, average_sale: 30 }),
      baseBucket({ start: "2026-05-11", count: 100, average_sale: 100 }),
    ]);
    // 100/30 = 3.333... → 3.333
    expect(s.momentumRatio).toBe(3.333);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TELEMETRY
// ─────────────────────────────────────────────────────────────────────────────

describe("logSalesMomentumObserved", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits sales_momentum_observed when signal has a latest week", () => {
    const signal = deriveSalesMomentum([
      baseBucket({ start: "2026-05-04", count: 100, average_sale: 50 }),
      baseBucket({ start: "2026-05-11", count: 200, average_sale: 100 }),
    ]);
    logSalesMomentumObserved({
      source: "compiq.price-by-id",
      player: "Nick Kurtz",
      cardId: "abc",
      signal,
      totalSales30d: 12879,
    });
    expect(logSpy).toHaveBeenCalled();
    const e = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(e.event).toBe("sales_momentum_observed");
    expect(e.player).toBe("Nick Kurtz");
    expect(e.cardId).toBe("abc");
    expect(e.momentumRatio).toBe(2);
    expect(e.volumeRatio).toBe(2);
    expect(e.totalSales30d).toBe(12879);
  });

  it("skips emission when signal has no latest week", () => {
    const empty = deriveSalesMomentum([]);
    logSalesMomentumObserved({
      source: "compiq.price-by-id",
      player: "Nobody",
      cardId: "abc",
      signal: empty,
      totalSales30d: null,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
