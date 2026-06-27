/**
 * TrendIQ composite computation — locked methodology per
 * docs/phase0/trendiq_design.md "Phase 1 methodology locks".
 *
 * Asserts the 8-row weight-table matrix, multiplier conversion, ±3%
 * direction deadband, impliedPct rounding, and grep-able log format.
 */

import { describe, it, expect } from "vitest";
import {
  buildPlayerMomentumComponent,
  computeCardTrajectory,
  computeSegmentTrajectory,
  computeSegmentTrajectoryAndFull,
  computeTrendIQ,
  formatTrendIQLogLine,
  type SegmentPoolInput,
} from "../src/services/compiq/trendIQ.compute.js";

describe("computeTrendIQ — 8-row weight table", () => {
  const p = (mult: number) => ({
    multiplier: mult,
    flags: [],
    componentSignals: {},
    lastUpdated: null,
    sourceUrl: null,
  });
  const c = (mult: number) => ({
    multiplier: mult,
    pctChange: (mult - 1) * 100,
    recentMedian: 100,
    olderMedian: 100 / mult,
    recentCount: 3,
    olderCount: 3,
    windowRecentDays: 14,
    windowOlderDays: 30,
  });
  const s = (mult: number) => ({
    multiplier: mult,
    pctChange: (mult - 1) * 100,
    effectiveAnchorDate: "2026-04-25T00:00:00.000Z",
    originalAnchorDate: "2026-04-25T00:00:00.000Z",
    windowDays: 60,
    preAnchorMedian: 100,
    postAnchorMedian: 100 * mult,
    preAnchorCount: 3,
    postAnchorCount: 3,
    siblingsScanned: 5,
    totalSamples: 20,
  });

  it("YYY full coverage: weights {0.20, 0.40, 0.40}", () => {
    const r = computeTrendIQ({
      playerMomentum: p(1.1),
      cardTrajectory: c(1.2),
      segmentTrajectory: s(1.3),
    });
    // 0.20*1.1 + 0.40*1.2 + 0.40*1.3 = 0.22 + 0.48 + 0.52 = 1.22
    expect(r.composite).toBeCloseTo(1.22, 2);
    expect(r.coverage).toBe("full");
    expect(r.direction).toBe("up");
    expect(r.weights).toEqual({
      playerMomentum: 0.2,
      cardTrajectory: 0.4,
      segmentTrajectory: 0.4,
    });
  });

  it("YYN no_segment: weights {0.30, 0.70, 0.00}", () => {
    const r = computeTrendIQ({
      playerMomentum: p(1.0),
      cardTrajectory: c(1.5),
      segmentTrajectory: null,
    });
    expect(r.coverage).toBe("no_segment");
    expect(r.weights.segmentTrajectory).toBe(0);
    expect(r.weights.cardTrajectory).toBe(0.7);
  });

  it("YNY no_card: weights {0.30, 0.00, 0.70}", () => {
    const r = computeTrendIQ({
      playerMomentum: p(1.0),
      cardTrajectory: null,
      segmentTrajectory: s(1.5),
    });
    expect(r.coverage).toBe("no_card");
    expect(r.weights).toEqual({
      playerMomentum: 0.3,
      cardTrajectory: 0,
      segmentTrajectory: 0.7,
    });
  });

  it("YNN player_only: weights {1.00, 0.00, 0.00}, composite == multiplier", () => {
    const r = computeTrendIQ({
      playerMomentum: p(1.25),
      cardTrajectory: null,
      segmentTrajectory: null,
    });
    expect(r.coverage).toBe("player_only");
    expect(r.composite).toBe(1.25);
    expect(r.direction).toBe("up");
    expect(r.impliedPct).toBe(25.0);
    expect(r.weights).toEqual({
      playerMomentum: 1.0,
      cardTrajectory: 0,
      segmentTrajectory: 0,
    });
  });

  it("NYY full (no L1): weights {0.00, 0.50, 0.50}", () => {
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: c(1.2),
      segmentTrajectory: s(0.8),
    });
    expect(r.coverage).toBe("full");
    expect(r.weights.playerMomentum).toBe(0);
    expect(r.composite).toBeCloseTo(1.0, 2);
    expect(r.direction).toBe("flat");
  });

  it("NYN card_only", () => {
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: c(0.85),
      segmentTrajectory: null,
    });
    expect(r.coverage).toBe("card_only");
    expect(r.composite).toBe(0.85);
    expect(r.direction).toBe("down");
  });

  it("NNY segment_only", () => {
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: null,
      segmentTrajectory: s(1.40),
    });
    expect(r.coverage).toBe("segment_only");
    expect(r.composite).toBe(1.4);
    expect(r.direction).toBe("up");
  });

  it("NNN insufficient: composite = 1.0 flat", () => {
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: null,
      segmentTrajectory: null,
    });
    expect(r.coverage).toBe("insufficient");
    expect(r.composite).toBe(1.0);
    expect(r.direction).toBe("flat");
    expect(r.impliedPct).toBe(0);
    expect(r.weights).toEqual({
      playerMomentum: 0,
      cardTrajectory: 0,
      segmentTrajectory: 0,
    });
    expect(r.lastUpdated).toBeNull();
  });
});

describe("computeTrendIQ — direction deadband ±3%", () => {
  const onlyPlayer = (mult: number) =>
    computeTrendIQ({
      playerMomentum: {
        multiplier: mult,
        flags: [],
        componentSignals: {},
        lastUpdated: null,
        sourceUrl: null,
      },
      cardTrajectory: null,
      segmentTrajectory: null,
    });

  it("composite 1.03 is flat (boundary)", () => {
    expect(onlyPlayer(1.03).direction).toBe("flat");
  });
  it("composite 1.04 is up", () => {
    expect(onlyPlayer(1.04).direction).toBe("up");
  });
  it("composite 0.97 is flat (boundary)", () => {
    expect(onlyPlayer(0.97).direction).toBe("flat");
  });
  it("composite 0.96 is down", () => {
    expect(onlyPlayer(0.96).direction).toBe("down");
  });
});

describe("computeTrendIQ — composite clamp 0.70..1.50", () => {
  it("clamps high outliers to 1.50", () => {
    const r = computeTrendIQ({
      playerMomentum: {
        multiplier: 1.5,
        flags: [],
        componentSignals: {},
        lastUpdated: null,
        sourceUrl: null,
      },
      cardTrajectory: null,
      segmentTrajectory: null,
    });
    expect(r.composite).toBe(1.5);
  });

  it("clamps low outliers to 0.70", () => {
    const r = computeTrendIQ({
      playerMomentum: {
        multiplier: 0.7,
        flags: [],
        componentSignals: {},
        lastUpdated: null,
        sourceUrl: null,
      },
      cardTrajectory: null,
      segmentTrajectory: null,
    });
    expect(r.composite).toBe(0.7);
  });
});

describe("buildPlayerMomentumComponent", () => {
  it("returns null when payload is null (fetch failed / unconfigured)", () => {
    expect(
      buildPlayerMomentumComponent({ payload: null, sourceUrl: null }),
    ).toBeNull();
  });

  it("builds component from real signal payload", () => {
    const result = buildPlayerMomentumComponent({
      payload: {
        final_multiplier: 1.18,
        signal_flags: ["trends_spike", "stats_hot"],
        components: { trends: 1.2, stats: 1.1 },
        updated_at: "2026-05-25T10:00:00Z",
      },
      sourceUrl: "https://example.azurewebsites.net/api/serve-signals",
    });
    expect(result).not.toBeNull();
    expect(result!.multiplier).toBe(1.18);
    expect(result!.flags).toEqual(["trends_spike", "stats_hot"]);
    expect(result!.lastUpdated).toBe("2026-05-25T10:00:00Z");
    expect(result!.sourceUrl).toBe(
      "https://example.azurewebsites.net/api/serve-signals",
    );
  });
});

describe("computeCardTrajectory — Layer 2 card-level comp trajectory", () => {
  // Pin "now" so day-based windowing is deterministic. 2026-05-25T12:00Z.
  const NOW = Date.parse("2026-05-25T12:00:00Z");
  const dayAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

  it("returns a directional read with 1 comp in each window (thin-comp support)", () => {
    const r = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(5) },  // recent (1)
        { price: 105, soldDate: dayAgo(30) }, // older (1)
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.recentCount).toBe(1);
    expect(r!.olderCount).toBe(1);
  });

  it("returns null when a window is empty (no before/after)", () => {
    // All comps in the recent window — older window empty.
    const rNoOlder = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(2) },
        { price: 110, soldDate: dayAgo(5) },
      ],
      NOW,
    );
    expect(rNoOlder).toBeNull();

    // All comps in the older window — recent window empty.
    const rNoRecent = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(20) },
        { price: 105, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    expect(rNoRecent).toBeNull();
  });

  it("returns null when both windows empty", () => {
    const r = computeCardTrajectory([], NOW);
    expect(r).toBeNull();
  });

  it("computes positive trajectory (recent > older)", () => {
    const r = computeCardTrajectory(
      [
        // recent (0..14d): median 110
        { price: 105, soldDate: dayAgo(2) },
        { price: 110, soldDate: dayAgo(5) },
        { price: 115, soldDate: dayAgo(10) },
        // older (15..45d): median 100
        { price: 95, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
        { price: 105, soldDate: dayAgo(40) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.recentMedian).toBe(110);
    expect(r!.olderMedian).toBe(100);
    expect(r!.pctChange).toBe(10);            // (110-100)/100*100 = 10
    expect(r!.multiplier).toBe(1.1);          // 1 + 10/100
    expect(r!.recentCount).toBe(3);
    expect(r!.olderCount).toBe(3);
    expect(r!.windowRecentDays).toBe(14);
    expect(r!.windowOlderDays).toBe(30);
  });

  it("computes negative trajectory (recent < older)", () => {
    const r = computeCardTrajectory(
      [
        // recent: median 80
        { price: 75, soldDate: dayAgo(3) },
        { price: 80, soldDate: dayAgo(7) },
        { price: 85, soldDate: dayAgo(12) },
        // older: median 100
        { price: 95, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(28) },
        { price: 105, soldDate: dayAgo(40) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(-20);           // (80-100)/100*100 = -20
    expect(r!.multiplier).toBe(0.8);
  });

  it("flat trajectory returns multiplier 1.0", () => {
    const r = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(2) },
        { price: 100, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(35) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(0);
    expect(r!.multiplier).toBe(1);
  });

  it("clamps pctChange to +50 (big move up)", () => {
    const r = computeCardTrajectory(
      [
        // recent median 200 (older 100 → +100% raw, clamped to +50)
        { price: 200, soldDate: dayAgo(2) },
        { price: 200, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(50);
    expect(r!.multiplier).toBe(1.5);
  });

  it("clamps pctChange to -50 (big move down); multiplier clamped further to 0.70", () => {
    // Design quirk worth knowing: pctChange clamps at ±50 but multiplier
    // separately clamps to [0.70, 1.50]. A -50% trend therefore reports
    // pctChange=-50 in the component (transparent to UI) but contributes
    // multiplier=0.70 to the composite (1 + -50/100 = 0.50, then clamped
    // up to 0.70). Composite-implied downside is therefore capped at -30%
    // even when a layer's raw trend is -50%. Upside is symmetric:
    // pctChange=+50 → multiplier=1.50 (no further clamp). Asymmetry
    // matches the player-momentum aggregator's own [0.70, 1.50] clamp.
    const r = computeCardTrajectory(
      [
        { price: 25, soldDate: dayAgo(2) },
        { price: 25, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(-50);
    expect(r!.multiplier).toBe(0.7);
  });

  it("ignores future-dated comps", () => {
    const future = new Date(NOW + 2 * 24 * 3600 * 1000).toISOString();
    const r = computeCardTrajectory(
      [
        { price: 9999, soldDate: future },     // ignored
        { price: 100, soldDate: dayAgo(2) },
        { price: 110, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.recentCount).toBe(2);            // future skipped
  });

  it("ignores invalid prices (zero, negative, NaN)", () => {
    const r = computeCardTrajectory(
      [
        { price: 0, soldDate: dayAgo(2) },     // ignored
        { price: -5, soldDate: dayAgo(2) },    // ignored
        { price: NaN, soldDate: dayAgo(2) },   // ignored
        { price: 100, soldDate: dayAgo(5) },
        { price: 110, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.recentCount).toBe(2);
  });

  it("ignores comps older than 45 days", () => {
    const r = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(2) },
        { price: 100, soldDate: dayAgo(10) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
        { price: 9999, soldDate: dayAgo(60) },    // ignored
        { price: 9999, soldDate: dayAgo(100) },   // ignored
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.olderCount).toBe(2);
    expect(r!.olderMedian).toBe(100);          // 9999s excluded
  });

  it("comp at exactly 14 days goes to recent window (inclusive boundary)", () => {
    const r = computeCardTrajectory(
      [
        { price: 100, soldDate: dayAgo(0) },
        { price: 105, soldDate: dayAgo(14) },   // boundary → recent
        { price: 200, soldDate: dayAgo(15) },   // → older
        { price: 210, soldDate: dayAgo(40) },
      ],
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.recentCount).toBe(2);
    expect(r!.olderCount).toBe(2);
  });

  it("computeTrendIQ propagates real Layer 2 with null L1/L3 → card_only", () => {
    const cardTraj = computeCardTrajectory(
      [
        { price: 110, soldDate: dayAgo(2) },
        { price: 115, soldDate: dayAgo(5) },
        { price: 100, soldDate: dayAgo(20) },
        { price: 100, soldDate: dayAgo(30) },
      ],
      NOW,
    );
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: cardTraj,
      segmentTrajectory: null,
    });
    expect(r.coverage).toBe("card_only");
    expect(r.weights).toEqual({
      playerMomentum: 0,
      cardTrajectory: 1,
      segmentTrajectory: 0,
    });
    expect(r.composite).toBe(cardTraj!.multiplier);
  });
});

describe("computeSegmentTrajectory — Layer 3 segment trajectory", () => {
  const NOW = Date.parse("2026-05-25T12:00:00Z");
  const daysAgo = (n: number) => NOW - n * 24 * 3600 * 1000;
  const isoAgo = (n: number) => new Date(daysAgo(n)).toISOString();

  /** Build a sibling pool from {price, daysAgo} pairs. */
  const pool = (
    sales: Array<{ price: number; daysAgo: number }>,
    siblingCount = 5,
  ): SegmentPoolInput => ({
    siblingCardIds: Array.from({ length: siblingCount }, (_, i) => `sibling-${i}`),
    sales: sales.map((s) => ({ price: s.price, ts: daysAgo(s.daysAgo) })),
  });

  it("returns null when newestTs <= 0 (no anchor — card never sold)", () => {
    const r = computeSegmentTrajectory(pool([]), 0, NOW);
    expect(r).toBeNull();
  });

  it("returns null when newestTs is NaN (defensive)", () => {
    const r = computeSegmentTrajectory(pool([]), NaN, NOW);
    expect(r).toBeNull();
  });

  it("returns null when anchor is < 7 days ago (post-window too short)", () => {
    const r = computeSegmentTrajectory(
      pool([
        { price: 100, daysAgo: 2 },
        { price: 100, daysAgo: 4 },
        { price: 100, daysAgo: 10 },
        { price: 100, daysAgo: 15 },
      ]),
      daysAgo(5), // anchor 5 days ago
      NOW,
    );
    expect(r).toBeNull();
  });

  it("returns null when sibling pool is empty", () => {
    const r = computeSegmentTrajectory(pool([]), daysAgo(30), NOW);
    expect(r).toBeNull();
  });

  it("returns a trajectory with 1 pre-anchor comp (thin-comp support)", () => {
    const r = computeSegmentTrajectory(
      pool([
        // anchor at 30d. pre-window: [60d, 30d]. only 1 in pre window.
        { price: 100, daysAgo: 45 },
        // 5 in post window (anchor, now)
        { price: 110, daysAgo: 25 },
        { price: 115, daysAgo: 20 },
        { price: 120, daysAgo: 15 },
        { price: 125, daysAgo: 10 },
        { price: 130, daysAgo: 5 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.preAnchorCount).toBe(1);
  });

  it("returns null when a segment window is empty (no before/after)", () => {
    // All sales in the pre window — post window empty.
    const r = computeSegmentTrajectory(
      pool([
        { price: 100, daysAgo: 35 },
        { price: 102, daysAgo: 40 },
        { price: 104, daysAgo: 45 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).toBeNull();
  });

  it("computes happy-path trajectory (anchor 30d ago, real pre/post pools)", () => {
    const r = computeSegmentTrajectory(
      pool(
        [
          // pre-window [60d, 30d]: median 100
          { price: 95, daysAgo: 55 },
          { price: 100, daysAgo: 45 },
          { price: 105, daysAgo: 35 },
          // post-window (30d, now]: median 120
          { price: 115, daysAgo: 20 },
          { price: 120, daysAgo: 15 },
          { price: 125, daysAgo: 5 },
        ],
        7, // siblingCount
      ),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.preAnchorMedian).toBe(100);
    expect(r!.postAnchorMedian).toBe(120);
    expect(r!.pctChange).toBe(20); // (120-100)/100*100
    expect(r!.multiplier).toBe(1.2);
    expect(r!.preAnchorCount).toBe(3);
    expect(r!.postAnchorCount).toBe(3);
    expect(r!.siblingsScanned).toBe(7);
    expect(r!.totalSamples).toBe(6);
    expect(r!.originalAnchorDate).toBe(isoAgo(30));
    expect(r!.effectiveAnchorDate).toBe(isoAgo(30)); // not re-anchored
    expect(r!.windowDays).toBe(60); // 30 pre + 30 post
  });

  it("re-anchors when originalAnchor > 180 days ago (Option C resolution)", () => {
    const r = computeSegmentTrajectory(
      pool([
        // anchor at 250 days ago → effectiveAnchor = now-90d
        // pre-window [now-120d, now-90d]: 2 comps
        { price: 100, daysAgo: 110 },
        { price: 100, daysAgo: 95 },
        // post-window (now-90d, now]: 2 comps
        { price: 130, daysAgo: 30 },
        { price: 130, daysAgo: 10 },
      ]),
      daysAgo(250),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.originalAnchorDate).toBe(isoAgo(250));
    // effectiveAnchorDate should be ~now - 90d (allowing ms-level fuzz on Date roundtrip)
    expect(r!.effectiveAnchorDate).not.toBe(r!.originalAnchorDate);
    expect(r!.pctChange).toBe(30);
    expect(r!.multiplier).toBe(1.3);
    expect(r!.windowDays).toBe(120); // 30 pre + 90 post
  });

  it("re-anchor: originalAnchorDate preserved while effectiveAnchorDate is now-90d", () => {
    const r = computeSegmentTrajectory(
      pool([
        { price: 50, daysAgo: 115 },
        { price: 50, daysAgo: 95 },
        { price: 50, daysAgo: 30 },
        { price: 50, daysAgo: 10 },
      ]),
      daysAgo(200),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.originalAnchorDate).toBe(isoAgo(200));
    // Parse effective and verify it's ~90 days ago (within 1 second tolerance)
    const effTs = Date.parse(r!.effectiveAnchorDate);
    const expectedTs = daysAgo(90);
    expect(Math.abs(effTs - expectedTs)).toBeLessThan(1000);
  });

  it("clamps positive pctChange to +50 (multiplier 1.50)", () => {
    const r = computeSegmentTrajectory(
      pool([
        // pre median 100, post median 250 → raw pct +150 → clamped to +50
        { price: 100, daysAgo: 35 },
        { price: 100, daysAgo: 45 },
        { price: 250, daysAgo: 20 },
        { price: 250, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(50);
    expect(r!.multiplier).toBe(1.5);
  });

  it("clamps negative pctChange to -50 AND multiplier asymmetrically to 0.70", () => {
    // Same asymmetric clamp as Layer 2 — locked methodology characteristic.
    // pctChange=-50 yields raw multiplier 0.50 which clamps UP to 0.70.
    // Composite-implied downside is capped at -30% per layer.
    const r = computeSegmentTrajectory(
      pool([
        // pre median 200, post median 20 → raw pct -90 → clamped to -50
        { price: 200, daysAgo: 35 },
        { price: 200, daysAgo: 45 },
        { price: 20, daysAgo: 20 },
        { price: 20, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.pctChange).toBe(-50);
    expect(r!.multiplier).toBe(0.7);
  });

  it("ignores sales with invalid prices (zero, negative, NaN)", () => {
    const r = computeSegmentTrajectory(
      pool([
        { price: 0, daysAgo: 35 }, // ignored
        { price: -10, daysAgo: 45 }, // ignored
        { price: NaN, daysAgo: 50 }, // ignored
        { price: 100, daysAgo: 35 },
        { price: 100, daysAgo: 45 },
        { price: 110, daysAgo: 20 },
        { price: 110, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.preAnchorCount).toBe(2); // zero/neg/NaN filtered
  });

  it("excludes sales outside both windows (older than pre-window, future)", () => {
    // daysAgo(-5) = NOW + 5d (future); daysAgo(100) is older than pre-window
    // start when anchor is 30d ago (pre-window = [60d, 30d]).
    const r = computeSegmentTrajectory(
      pool([
        { price: 999, daysAgo: 100 }, // older than 60d (outside pre window)
        { price: 999, daysAgo: -5 }, // future date (outside post window)
        { price: 100, daysAgo: 35 },
        { price: 100, daysAgo: 50 },
        { price: 110, daysAgo: 20 },
        { price: 110, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.preAnchorCount).toBe(2); // 100d sale excluded
    expect(r!.postAnchorCount).toBe(2); // future date excluded
  });

  it("computeTrendIQ propagates Layer 3 with null L1/L2 → segment_only", () => {
    const segment = computeSegmentTrajectory(
      pool([
        { price: 100, daysAgo: 35 },
        { price: 100, daysAgo: 45 },
        { price: 110, daysAgo: 20 },
        { price: 110, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    const r = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: null,
      segmentTrajectory: segment,
    });
    expect(r.coverage).toBe("segment_only");
    expect(r.weights).toEqual({
      playerMomentum: 0,
      cardTrajectory: 0,
      segmentTrajectory: 1,
    });
    expect(r.composite).toBe(segment!.multiplier);
  });

  it("computeTrendIQ with all three layers populated → coverage='full', weights {0.20, 0.40, 0.40}", () => {
    const segment = computeSegmentTrajectory(
      pool([
        { price: 100, daysAgo: 35 },
        { price: 100, daysAgo: 45 },
        { price: 120, daysAgo: 20 },
        { price: 120, daysAgo: 10 },
      ]),
      daysAgo(30),
      NOW,
    );
    const cardTraj = computeCardTrajectory(
      [
        { price: 150, soldDate: new Date(daysAgo(2)).toISOString() },
        { price: 155, soldDate: new Date(daysAgo(10)).toISOString() },
        { price: 130, soldDate: new Date(daysAgo(20)).toISOString() },
        { price: 130, soldDate: new Date(daysAgo(30)).toISOString() },
      ],
      NOW,
    );
    const r = computeTrendIQ({
      playerMomentum: {
        multiplier: 1.05,
        flags: [],
        componentSignals: {},
        lastUpdated: null,
        sourceUrl: null,
      },
      cardTrajectory: cardTraj,
      segmentTrajectory: segment,
    });
    expect(r.coverage).toBe("full");
    expect(r.weights).toEqual({
      playerMomentum: 0.2,
      cardTrajectory: 0.4,
      segmentTrajectory: 0.4,
    });
    // composite = 0.2*1.05 + 0.4*cardTraj.mult + 0.4*segment.mult
    const expected =
      0.2 * 1.05 + 0.4 * cardTraj!.multiplier + 0.4 * segment!.multiplier;
    expect(r.composite).toBeCloseTo(expected, 2);
  });
});

// ─── CF-TRENDIQ-SURFACES (2026-06-03) GUARDRAIL ────────────────────────────
//
// The /trendiq/full surface added `computeSegmentTrajectoryAndFull`. The
// original `computeSegmentTrajectory` was refactored to delegate to it.
// This guardrail pins that the refactor is PURELY ADDITIVE — the
// SegmentTrajectoryComponent (what composite math reads) is byte-identical
// to the pre-refactor return for every meaningful input class.

describe("CF-TRENDIQ-SURFACES — computeSegmentTrajectory composite-unchanged pin", () => {
  // Build a deterministic pool where pre-anchor sits in [eff-30d, eff] and
  // post-anchor sits in (eff, now]. Effective anchor = newestTs (no
  // re-anchor because anchor is 14 days old, well under the 180d threshold).
  const NOW = Date.parse("2026-06-03T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const newestTs = NOW - 14 * DAY; // anchor = 2026-05-20

  const pool: SegmentPoolInput = {
    siblingCardIds: ["sib-A", "sib-B", "sib-C"],
    sales: [
      // pre-anchor (within 30d before anchor)
      { price: 90, ts: newestTs - 25 * DAY },
      { price: 100, ts: newestTs - 20 * DAY },
      { price: 105, ts: newestTs - 10 * DAY },
      // post-anchor (between anchor and now)
      { price: 115, ts: newestTs + 3 * DAY },
      { price: 120, ts: newestTs + 7 * DAY },
      { price: 125, ts: newestTs + 12 * DAY },
    ],
  };

  it("computeSegmentTrajectory output is byte-identical to AndFull().component", () => {
    const legacy = computeSegmentTrajectory(pool, newestTs, NOW);
    const rich = computeSegmentTrajectoryAndFull(pool, newestTs, NOW);
    expect(legacy).toEqual(rich.component);
  });

  it("composite TrendIQResult is unchanged whether segmentTrajectory is sourced from legacy or rich helper", () => {
    const legacy = computeSegmentTrajectory(pool, newestTs, NOW);
    const rich = computeSegmentTrajectoryAndFull(pool, newestTs, NOW);
    const cardTraj = {
      multiplier: 1.1,
      pctChange: 10,
      recentMedian: 110,
      olderMedian: 100,
      recentCount: 5,
      olderCount: 6,
      windowRecentDays: 14,
      windowOlderDays: 30,
    };
    const fromLegacy = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: cardTraj,
      segmentTrajectory: legacy,
    });
    const fromRich = computeTrendIQ({
      playerMomentum: null,
      cardTrajectory: cardTraj,
      segmentTrajectory: rich.component,
    });
    expect(fromLegacy).toEqual(fromRich);
  });

  it("null-component cases also stay byte-identical (no_anchor + sparse_pool + anchor_too_recent)", () => {
    // no_anchor (newestTs = 0)
    expect(computeSegmentTrajectory(pool, 0, NOW)).toBeNull();
    expect(computeSegmentTrajectoryAndFull(pool, 0, NOW).component).toBeNull();
    expect(computeSegmentTrajectoryAndFull(pool, 0, NOW).full).toBeNull();

    // anchor_too_recent (anchor 3 days ago — under POST_WINDOW_MIN_AGE_DAYS=7)
    const recentAnchor = NOW - 3 * DAY;
    expect(computeSegmentTrajectory(pool, recentAnchor, NOW)).toBeNull();
    expect(
      computeSegmentTrajectoryAndFull(pool, recentAnchor, NOW).component,
    ).toBeNull();

    // sparse_pool — same anchor but pool too thin
    const sparsePool: SegmentPoolInput = {
      siblingCardIds: ["only"],
      sales: [{ price: 100, ts: newestTs - 5 * DAY }],
    };
    expect(computeSegmentTrajectory(sparsePool, newestTs, NOW)).toBeNull();
    expect(
      computeSegmentTrajectoryAndFull(sparsePool, newestTs, NOW).component,
    ).toBeNull();
  });

  it("rich .full carries raw pre/post sales rows, siblingCardIds, reanchor flag, perWindow stats", () => {
    const rich = computeSegmentTrajectoryAndFull(pool, newestTs, NOW);
    expect(rich.full).not.toBeNull();
    expect(rich.full!.siblingCardIds).toEqual(["sib-A", "sib-B", "sib-C"]);
    expect(rich.full!.reanchorApplied).toBe(false);
    expect(rich.full!.preAnchorSales.length).toBe(3);
    expect(rich.full!.postAnchorSales.length).toBe(3);
    // Rows sorted oldest -> newest.
    expect(rich.full!.preAnchorSales[0].price).toBe(90);
    expect(rich.full!.postAnchorSales[2].price).toBe(125);
    // perWindow mean check (pre 90/100/105 = 98.33; post 115/120/125 = 120).
    expect(rich.full!.perWindow.pre.mean).toBeCloseTo(98.33, 1);
    expect(rich.full!.perWindow.post.mean).toBe(120);
    expect(rich.full!.perWindow.pre.p75).toBeGreaterThanOrEqual(
      rich.full!.perWindow.pre.p25,
    );
  });

  it("reanchorApplied=true when anchor is older than 180d", () => {
    const veryOldAnchor = NOW - 250 * DAY;
    // Build a pool with sales straddling the re-anchored window
    // (effective anchor = now - 90d).
    const effAnchor = NOW - 90 * DAY;
    const oldPool: SegmentPoolInput = {
      siblingCardIds: ["a", "b"],
      sales: [
        { price: 80, ts: effAnchor - 20 * DAY },
        { price: 82, ts: effAnchor - 10 * DAY },
        { price: 95, ts: effAnchor + 10 * DAY },
        { price: 98, ts: effAnchor + 20 * DAY },
      ],
    };
    const rich = computeSegmentTrajectoryAndFull(oldPool, veryOldAnchor, NOW);
    expect(rich.full).not.toBeNull();
    expect(rich.full!.reanchorApplied).toBe(true);
    expect(rich.full!.originalAnchorDate).toBe(new Date(veryOldAnchor).toISOString());
    expect(rich.full!.effectiveAnchorDate).toBe(new Date(effAnchor).toISOString());
  });
});

describe("formatTrendIQLogLine — grep-able production log", () => {
  it("matches the locked format from trendiq_design.md", () => {
    const r = computeTrendIQ({
      playerMomentum: {
        multiplier: 1.18,
        flags: [],
        componentSignals: {},
        lastUpdated: null,
        sourceUrl: null,
      },
      cardTrajectory: null,
      segmentTrajectory: null,
    });
    const line = formatTrendIQLogLine(r);
    expect(line).toBe(
      "[compiq.trendIQ] composite=1.18 direction=up coverage=player_only weights=p:1.00/c:0.00/s:0.00",
    );
  });
});
