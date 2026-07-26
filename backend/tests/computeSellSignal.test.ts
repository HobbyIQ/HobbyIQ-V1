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
    it("sell-now reason includes % and comp count", () => {
      const r = computeSellSignal(25, 12, 100);
      expect(r.reason).toBe("Up 25.0% in last 30d (12 sales in 90d)");
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
});
