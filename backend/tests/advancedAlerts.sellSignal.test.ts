/**
 * CF-SELLER-INTELLIGENCE-SELL-WINDOW — alert wiring pins (Drew, 2026-09-02).
 *
 * The rule fires on a TRANSITION into a signal state, and it is OFF BY
 * DEFAULT. Both halves are pinned here:
 *
 *   - the evaluator DOES understand the condition and fires on the
 *     transition when a previous slice is supplied (so arming it later is
 *     a real switch, not a stub);
 *   - the API REFUSES to create the rule today, because without per-rule
 *     previous-slice storage it could only ever be false — the same launch
 *     trap price_crosses is held back for.
 *
 * Also pinned: the 0..100 → 0..1 confidence scaling in sliceEstimate. Get
 * that wrong and every holding reads as below the confidence floor, which
 * would look like "the signal never fires" rather than a unit bug.
 */

import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../src/services/advancedAlerts/conditionEvaluator.js";
import { sliceEstimate } from "../src/services/advancedAlerts/ruleEvaluator.js";
import type { EvaluationEstimateSlice } from "../src/services/advancedAlerts/conditionEvaluator.js";
import type { SellSignal } from "../src/services/signals/sellWindow.service.js";

function slice(sellSignal: SellSignal | null | undefined): EvaluationEstimateSlice {
  return {
    fairMarketValue: 100,
    predictedPrice: 105,
    pricingConfidence: 70,
    trendIQ: null,
    sellSignal,
  };
}

const OPENS = { kind: "sell_signal_becomes", becomes: "sell-window" } as const;

describe("sell_signal_becomes: transition semantics", () => {
  it("fires when the signal enters the target state", () => {
    expect(evaluateCondition(OPENS, slice("sell-window"), slice("watch"))).toBe(true);
    expect(evaluateCondition(OPENS, slice("sell-window"), slice("none"))).toBe(true);
  });

  it("does NOT re-fire while the window stays open", () => {
    // The whole point of a transition: a week-old open window is not news.
    expect(evaluateCondition(OPENS, slice("sell-window"), slice("sell-window"))).toBe(false);
  });

  it("does not fire on a first observation with no previous slice", () => {
    expect(evaluateCondition(OPENS, slice("sell-window"), null)).toBe(false);
  });

  it("does not fire when the signal is not derived on either side", () => {
    expect(evaluateCondition(OPENS, slice(undefined), slice(undefined))).toBe(false);
    expect(evaluateCondition(OPENS, slice("sell-window"), slice(undefined))).toBe(false);
  });

  it("distinguishes the target state from other states", () => {
    const toHold = { kind: "sell_signal_becomes", becomes: "hold" } as const;
    expect(evaluateCondition(toHold, slice("hold"), slice("none"))).toBe(true);
    expect(evaluateCondition(toHold, slice("sell-window"), slice("none"))).toBe(false);
  });
});

describe("sliceEstimate: confidence unit scaling", () => {
  // A rollover shape that WOULD fire, so the only thing under test is
  // whether the confidence scaling wrongly suppresses it.
  const trendIQ = {
    composite: 1.0,
    direction: "flat",
    impliedPct: 0,
    lastUpdated: new Date().toISOString(),
    coverage: "no_segment",
    weights: { playerMomentum: 0.2, cardTrajectory: 0.4, segmentTrajectory: 0.4 },
    components: {
      playerMomentum: {
        multiplier: 0.96,
        flags: ["player_in_set", "falling"],
        componentSignals: {},
        lastUpdated: new Date().toISOString(),
        sourceUrl: null,
      },
      cardTrajectory: {
        multiplier: 1.11,
        pctChange: 11,
        recentMedian: 111,
        olderMedian: 100,
        recentCount: 7,
        olderCount: 9,
        windowRecentDays: 14,
        windowOlderDays: 30,
      },
      segmentTrajectory: null,
    },
  };

  it("treats pricingConfidence 70 as 0.70, not 70.0 — the signal still fires", () => {
    const s = sliceEstimate({ fairMarketValue: 100, predictedPrice: 105, confidence: 70, trendIQ });
    expect(s.sellSignal).toBe("sell-window");
  });

  it("a genuinely low confidence still suppresses the call", () => {
    const s = sliceEstimate({ fairMarketValue: 100, predictedPrice: 105, confidence: 10, trendIQ });
    expect(s.sellSignal).toBe("none");
  });

  it("no trendIQ on the estimate leaves the signal underived (never a false state)", () => {
    const s = sliceEstimate({ fairMarketValue: 100, predictedPrice: 105, confidence: 70 });
    expect(s.sellSignal).toBeNull();
  });
});

// The "off by default" half is pinned against the real HTTP layer in
// advancedAlerts.routes.test.ts ("rejects sell_signal_becomes with 'not yet
// supported' message"), alongside the two crossing kinds it shares its
// previous-slice dependency with.
