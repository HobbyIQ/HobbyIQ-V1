// CF-SELL-SIGNAL (Drew, 2026-07-26). Pins the decision boundaries for
// the /card-search per-hit signal tag. Product doctrine: actionable
// intelligence, not prediction accuracy — thresholds are HONEST
// defaults, not tuned parameters (yet). If we ever tune, this test
// updates and everyone knows the rules changed.

import { describe, it, expect } from "vitest";
import { computeSellSignal } from "../src/services/portfolioiq/canonicalCardSearch.service.js";

describe("computeSellSignal", () => {
  describe("watch — insufficient signal gate", () => {
    it("returns watch when momentumPct is null (no fresh trend data)", () => {
      const r = computeSellSignal(null, 10, 100);
      expect(r.signal).toBe("watch");
      expect(r.reason).toMatch(/Insufficient signal/i);
    });

    it("returns watch when compCount < 5 even with big momentum", () => {
      const r = computeSellSignal(30, 4, 100);
      expect(r.signal).toBe("watch");
      expect(r.reason).toMatch(/only 4 sales/);
    });

    it("returns watch when compCount is 0", () => {
      const r = computeSellSignal(null, 0, 500);
      expect(r.signal).toBe("watch");
      expect(r.reason).toMatch(/no recent sales/i);
    });

    it("returns watch on mid-range momentum (5% < |m| < 15%) — not a spike, not stable", () => {
      const upMid = computeSellSignal(10, 20, 100);
      expect(upMid.signal).toBe("watch");
      expect(upMid.reason).toMatch(/up 10\.0%/);
      const downMid = computeSellSignal(-8, 20, 100);
      expect(downMid.signal).toBe("watch");
      expect(downMid.reason).toMatch(/down 8\.0%/);
    });
  });

  describe("sell-now — real spike detected", () => {
    it("at the +15% threshold exactly (inclusive lower bound)", () => {
      const r = computeSellSignal(15, 5, 100);
      expect(r.signal).toBe("sell-now");
      expect(r.reason).toMatch(/Up 15\.0%/);
      expect(r.reason).toMatch(/5 sales/);
    });

    it("well above the threshold", () => {
      const r = computeSellSignal(42.5, 20, 100);
      expect(r.signal).toBe("sell-now");
      expect(r.reason).toMatch(/Up 42\.5%/);
    });

    it("compCount at exactly 5 (minimum for action) passes", () => {
      const r = computeSellSignal(20, 5, 100);
      expect(r.signal).toBe("sell-now");
    });
  });

  describe("buy — real drawdown detected", () => {
    it("at the -15% threshold exactly", () => {
      const r = computeSellSignal(-15, 5, 100);
      expect(r.signal).toBe("buy");
      expect(r.reason).toMatch(/Down 15\.0%/);
    });

    it("well below the threshold", () => {
      const r = computeSellSignal(-32.5, 20, 100);
      expect(r.signal).toBe("buy");
      expect(r.reason).toMatch(/Down 32\.5%/);
    });
  });

  describe("hold — stable within ±5% band", () => {
    it("at 0% momentum (perfectly stable)", () => {
      const r = computeSellSignal(0, 20, 100);
      expect(r.signal).toBe("hold");
      expect(r.reason).toMatch(/Stable/i);
    });

    it("at +5% edge (inclusive)", () => {
      const r = computeSellSignal(5, 20, 100);
      expect(r.signal).toBe("hold");
    });

    it("at -5% edge (inclusive)", () => {
      const r = computeSellSignal(-5, 20, 100);
      expect(r.signal).toBe("hold");
    });

    it("just past 5% flips out of hold", () => {
      const r = computeSellSignal(5.5, 20, 100);
      expect(r.signal).toBe("watch");  // mid-range, not spike, not stable
    });
  });

  describe("reason messaging carries the numbers iOS renders", () => {
    it("sell-now reason includes % and comp count and default target", () => {
      const r = computeSellSignal(25, 12, 100);
      expect(r.reason).toMatch(/Up 25\.0%/);
      expect(r.reason).toMatch(/12 sales in 90d/);
      expect(r.reason).toMatch(/\+15% target/);   // default sell threshold
    });

    it("buy reason includes abs % and comp count", () => {
      const r = computeSellSignal(-20, 8, 100);
      expect(r.reason).toBe("Down 20.0% in last 30d (8 sales in 90d)");
    });

    it("hold reason includes the stable-band width", () => {
      const r = computeSellSignal(2, 10, 100);
      expect(r.reason).toMatch(/±5%/);
    });
  });

  // CF-SELL-SIGNAL-USER-THRESHOLD (Drew, 2026-07-26). User-configurable
  // sell-now boundary. Buy/hold/watch stay locked at doctrine defaults.
  describe("user-configurable sellThresholdPct", () => {
    it("caller sets threshold to 20 → +18% momentum is 'watch' (below), +22% is 'sell-now'", () => {
      const below = computeSellSignal(18, 10, 100, { sellThresholdPct: 20 });
      expect(below.signal).toBe("watch");  // mid-range under user's higher bar
      const above = computeSellSignal(22, 10, 100, { sellThresholdPct: 20 });
      expect(above.signal).toBe("sell-now");
      expect(above.reason).toMatch(/\+20% target/);
    });

    it("caller sets threshold to 10 (more aggressive) → +12% momentum flips to 'sell-now'", () => {
      const r = computeSellSignal(12, 10, 100, { sellThresholdPct: 10 });
      expect(r.signal).toBe("sell-now");
      expect(r.reason).toMatch(/\+10% target/);
    });

    it("does NOT change the buy boundary — -12% stays 'watch' even with sellThreshold=10", () => {
      const r = computeSellSignal(-12, 10, 100, { sellThresholdPct: 10 });
      expect(r.signal).toBe("watch");  // buy is locked at -15
    });

    it("does NOT change hold band — 3% momentum stays 'hold' regardless of sellThreshold", () => {
      const r = computeSellSignal(3, 10, 100, { sellThresholdPct: 50 });
      expect(r.signal).toBe("hold");
    });

    it("clamps out-of-range values: sellThresholdPct=1000 clamps to 100 (max)", () => {
      // A bogus 1000% threshold clamps to 100. Below-100 momentum stays
      // out of sell-now; at-or-above-100 fires.
      const belowClamp = computeSellSignal(20, 10, 100, { sellThresholdPct: 1000 });
      expect(belowClamp.signal).toBe("watch");   // 20 < clamped-100
      const atClamp = computeSellSignal(100, 10, 100, { sellThresholdPct: 1000 });
      expect(atClamp.signal).toBe("sell-now");
      expect(atClamp.reason).toMatch(/\+100% target/);
    });

    it("clamps below-min: sellThresholdPct=2 (< 5 min) falls to 5", () => {
      const r = computeSellSignal(6, 10, 100, { sellThresholdPct: 2 });
      expect(r.signal).toBe("sell-now");
      expect(r.reason).toMatch(/\+5% target/);
    });

    it("NaN sellThresholdPct silently falls to default 15", () => {
      const r = computeSellSignal(16, 10, 100, { sellThresholdPct: NaN });
      expect(r.signal).toBe("sell-now");    // 16 > default 15
      expect(r.reason).toMatch(/\+15% target/);
    });

    it("negative sellThresholdPct silently falls to clamped 5", () => {
      const r = computeSellSignal(6, 10, 100, { sellThresholdPct: -10 });
      expect(r.signal).toBe("sell-now");   // clamped to 5, 6 > 5
    });

    it("compCount<5 gate still overrides regardless of threshold", () => {
      const r = computeSellSignal(50, 3, 100, { sellThresholdPct: 10 });
      expect(r.signal).toBe("watch");
      expect(r.reason).toMatch(/only 3 sales/);
    });
  });
});
