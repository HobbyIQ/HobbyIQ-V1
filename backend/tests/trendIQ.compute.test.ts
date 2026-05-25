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
  computeTrendIQ,
  formatTrendIQLogLine,
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
