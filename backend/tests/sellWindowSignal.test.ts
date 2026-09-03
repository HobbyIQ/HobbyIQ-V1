/**
 * CF-SELLER-INTELLIGENCE-SELL-WINDOW pins (Drew, 2026-09-02).
 *
 * The derivation is pure, so every case here is a FIXTURE — a persisted
 * TrendIQ shape in, a signal out. No Cosmos, no clock, no network.
 *
 * What is pinned, and why each one:
 *   1. Rollover fires sell-window     — the product thesis itself.
 *   2. Flat fires none                — the signal must be quiet by default;
 *                                       a chip on every holding is noise.
 *   3. Thin pools REFUSE WITH REASON  — "no signal" and "could not look" are
 *                                       different facts.
 *   4. Horizon matches the class      — the doctrine invariant, checked on
 *                                       every emitted signal, not just the
 *                                       happy path.
 *   5. No certainty language          — recommendations state basis, never
 *                                       a promise.
 */

import { describe, it, expect } from "vitest";
import {
  deriveSellWindowSignal,
  horizonClassMatches,
  horizonForWindows,
  DIVERGENCE_FIRE_PTS,
  MIN_OWN_POOL_SALES,
  MAX_TREND_AGE_DAYS,
  type SellWindowSignal,
} from "../src/services/signals/sellWindow.service.js";
import type {
  TrendIQResult,
  PlayerMomentumComponent,
  CardTrajectoryComponent,
} from "../src/services/compiq/trendIQ.types.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const FRESH = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

function playerMomentum(multiplier: number, flags: string[] = []): PlayerMomentumComponent {
  return {
    multiplier,
    flags: ["player_in_set", ...flags],
    componentSignals: { pool_size: 40, cards_in_pool: 8, qualifying_cards: 6 },
    lastUpdated: FRESH,
    sourceUrl: null,
  };
}

function cardTrajectory(
  multiplier: number,
  recentCount = 7,
  olderCount = 9,
  windowRecentDays = 14,
): CardTrajectoryComponent {
  return {
    multiplier,
    pctChange: Math.round((multiplier - 1) * 1000) / 10,
    recentMedian: 100 * multiplier,
    olderMedian: 100,
    recentCount,
    olderCount,
    windowRecentDays,
    windowOlderDays: 30,
  };
}

function trend(
  player: PlayerMomentumComponent | null,
  card: CardTrajectoryComponent | null,
): TrendIQResult {
  return {
    composite: 1.0,
    direction: "flat",
    impliedPct: 0,
    lastUpdated: FRESH,
    components: { playerMomentum: player, cardTrajectory: card, segmentTrajectory: null },
    weights: { playerMomentum: 0.2, cardTrajectory: 0.4, segmentTrajectory: 0.4 },
    coverage: "no_segment",
  };
}

/** Every signal, however derived, must satisfy the doctrine invariant. */
function assertHorizonDoctrine(sig: SellWindowSignal): void {
  expect(horizonClassMatches(sig.signal, sig.horizon, sig.signalClass)).toBe(true);
}

describe("sell-window: the product thesis", () => {
  it("fires sell-window when the player index rolls over while the card's own pool is still hot", () => {
    // Player -4% (rolling over), card +11% (still hot) => 15-point gap.
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });

    expect(sig.signal).toBe("sell-window");
    expect(sig.reason).toBeNull();
    expect(sig.measures.playerIndexPct).toBe(-4);
    expect(sig.measures.ownPoolPct).toBe(11);
    expect(sig.measures.divergencePct).toBe(-15);
    // The basis QUOTES the numbers — a seller can check the claim.
    expect(sig.basis).toContain("-4%");
    expect(sig.basis).toContain("11%");
    expect(sig.basis).toContain("15");
    assertHorizonDoctrine(sig);
  });

  it("does NOT fire when the card is up but the player is up too — a hot card in a hot market is not a cascade", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(1.2), cardTrajectory(1.32)),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).not.toBe("sell-window");
    assertHorizonDoctrine(sig);
  });

  it("calls hold when the player is running and the card has not caught up", () => {
    // Player +18%, card +2% => +16 divergence in the card's favour.
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(1.18), cardTrajectory(1.02)),
      confidence: 0.8,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("hold");
    expect(sig.basis).toContain("18%");
    assertHorizonDoctrine(sig);
  });

  it("says watch when the gap is forming but under the firing bar", () => {
    // Player -1%, card +7% => 8-point gap: over watch (6), under fire (12).
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.99), cardTrajectory(1.07)),
      confidence: 0.7,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("watch");
    expect(Math.abs(sig.measures.divergencePct!)).toBeLessThan(DIVERGENCE_FIRE_PTS);
    assertHorizonDoctrine(sig);
  });
});

describe("sell-window: quiet by default", () => {
  it("fires none when both sides are flat", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(1.0), cardTrajectory(1.0)),
      confidence: 0.8,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.horizon).toBe("none");
    expect(sig.reason).toBe("player-and-pool-agree");
    assertHorizonDoctrine(sig);
  });

  it("fires none when player and pool move together — no timing edge", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(1.09), cardTrajectory(1.11)),
      confidence: 0.8,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("player-and-pool-agree");
    assertHorizonDoctrine(sig);
  });
});

describe("sell-window: refusal is a result, and it names what was missing", () => {
  it("refuses a thin own-pool with a reason and the count quoted", () => {
    const sig = deriveSellWindowSignal({
      // Same rollover shape as the firing case, but only 4 sales total.
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11, 2, 2)),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("thin-own-pool");
    expect(sig.measures.ownPoolSales).toBe(4);
    expect(sig.basis).toContain("4 sales");
    expect(sig.basis).toContain(String(MIN_OWN_POOL_SALES));
    assertHorizonDoctrine(sig);
  });

  it("refuses when the player index could not be built", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(null, cardTrajectory(1.11)),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("no-player-index");
    assertHorizonDoctrine(sig);
  });

  it("refuses when the card's own pool has no direction", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96), null),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("no-own-pool");
    assertHorizonDoctrine(sig);
  });

  it("refuses a stale trend rather than timing a sale off an old read", () => {
    const stale = new Date(NOW - (MAX_TREND_AGE_DAYS + 6) * 24 * 60 * 60 * 1000).toISOString();
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: 0.72,
      trendUpdatedAt: stale,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("stale-trend");
    assertHorizonDoctrine(sig);
  });

  it("refuses below the confidence floor", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: 0.2,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("low-confidence");
    assertHorizonDoctrine(sig);
  });

  // ── CF-SELL-WINDOW-READS-PRICING-CONFIDENCE pins (2026-09-03) ──────────
  //
  // The signal gates on, and quotes to the user, the PRICING confidence. It
  // used to read the holding's flat `confidence` field — identity/match
  // confidence on unified-engine rows, and saturated to exactly 1.0 by the
  // scaling defect fixed in the same PR. Two things are pinned here: that a
  // real pricing confidence beats a flat 1.0, and that an UNRECORDED one is
  // never silently treated as full confidence.

  it("gates on the engine's pricing confidence, not a flat 1.0 identity score", () => {
    // The exact defect shape: flat confidence 1.0 (saturated), real pricing
    // confidence 0.30 — under the 0.35 floor. The gate must use 0.30.
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: 0.30,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("low-confidence");
    // The percentage quoted is the pricing confidence, not 100%.
    expect(sig.basis).toContain("30%");
    expect(sig.basis).not.toContain("100%");
    expect(sig.measures.confidence).toBe(0.30);
    assertHorizonDoctrine(sig);
  });

  it("withholds the timing call when pricing confidence is not recorded, claiming no percentage", () => {
    // null = not yet stamped by a reprice. Never 100%. The trend shape here
    // is the FIRING one, so this proves the refusal is the confidence gate
    // and not some other bar.
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: null,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("unknown-confidence");
    expect(sig.measures.confidence).toBeNull();
    // It must not claim a number it does not have.
    expect(sig.basis).not.toMatch(/\d+%/);
    expect(sig.basis).toContain("not been recorded");
    assertHorizonDoctrine(sig);
  });

  it("an omitted confidence is treated as unrecorded, not as full confidence", () => {
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("unknown-confidence");
    assertHorizonDoctrine(sig);
  });

  it("refuses with no trend at all", () => {
    const sig = deriveSellWindowSignal({ trendIQ: null, nowMs: NOW });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("no-trend-data");
    assertHorizonDoctrine(sig);
  });
});

describe("sell-window: horizon must match the signal class (doctrine)", () => {
  it("a price-class signal never claims a sub-week horizon", () => {
    // days-0-3 is an attention-class band; a price signal may not claim one.
    expect(horizonClassMatches("sell-window", "none", "price")).toBe(false);
    expect(horizonClassMatches("sell-window", "days-14-30", "price")).toBe(true);
    expect(horizonClassMatches("sell-window", "days-7-14", "price")).toBe(true);
  });

  it("a signal with no call claims no horizon", () => {
    expect(horizonClassMatches("none", "none", "price")).toBe(true);
    expect(horizonClassMatches("none", "days-14-30", "price")).toBe(false);
  });

  it("attention-class cannot borrow a price horizon", () => {
    // No attention input exists yet; nothing may claim the class.
    expect(horizonClassMatches("sell-window", "days-14-30", "attention")).toBe(false);
  });

  it("the horizon is derived from the window that produced it, not chosen", () => {
    expect(horizonForWindows(14)).toBe("days-14-30");
    expect(horizonForWindows(7)).toBe("days-7-14");
    // A 14d recent window yields the 14-30d band on the firing path.
    const sig = deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11, 7, 9, 14)),
      confidence: 0.72,
      trendUpdatedAt: FRESH,
      nowMs: NOW,
    });
    expect(sig.horizon).toBe("days-14-30");
    expect(sig.signalClass).toBe("price");
  });
});

describe("sell-window: states basis, never certainty", () => {
  const cases: SellWindowSignal[] = [
    deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.96, ["falling"]), cardTrajectory(1.11)),
      confidence: 0.72, trendUpdatedAt: FRESH, nowMs: NOW,
    }),
    deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(1.18), cardTrajectory(1.02)),
      confidence: 0.8, trendUpdatedAt: FRESH, nowMs: NOW,
    }),
    deriveSellWindowSignal({
      trendIQ: trend(playerMomentum(0.99), cardTrajectory(1.07)),
      confidence: 0.7, trendUpdatedAt: FRESH, nowMs: NOW,
    }),
  ];

  it("no basis sentence promises an outcome", () => {
    const forbidden = /\b(will|guarantee[d]?|certain|definitely|must sell|always)\b/i;
    for (const sig of cases) {
      expect(sig.basis).not.toMatch(forbidden);
      expect(sig.basis.length).toBeGreaterThan(20);
    }
  });

  it("every emitted signal quotes its numbers", () => {
    for (const sig of cases) {
      expect(sig.basis).toMatch(/-?\d+(\.\d+)?%/);
      expect(sig.measures.divergencePct).not.toBeNull();
    }
  });
});
