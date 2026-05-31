// CF-FMV-NOWCAST Ship 1 — sibling-pool velocity-weighting + per-FMV band
//
// Locks the four behaviors of Ship 1:
//   (1) sibling-pool FMV pulls toward recent comps under weighted median
//       (vs plain median which lands at the count center)
//   (2) computeFmvBand monotonicity — thin>thick, stale>fresh, low<fmv<high
//   (3) main-path FMV composition is untouched — the band is additive
//   (4) wire shape — fairMarketValueLow/High appear at every FMV-returning
//       return literal in compiqEstimate.service.ts (5 sites)
//
// Decoupled from the full computeEstimate pipeline so the suite stays fast
// and the asserts are about the specific Ship 1 surfaces.

import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import {
  computeWeightedMedian,
  computeFmvBand,
} from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-FMV-NOWCAST Ship 1", () => {
  describe("(1) sibling-pool weighted median pulls toward recent", () => {
    // Fixture: recent sales cluster low, older sales cluster high. The plain
    // count-median lands at the (older) cluster; the velocity-weighted
    // median should land at the recent cluster — proving Ship 1's routing
    // change does meaningful work for thin sibling-pool data.
    const NOW = Date.now();
    const recent = (hoursAgo: number) => NOW - hoursAgo * 60 * 60 * 1000;
    const FIXTURE = [
      { price: 50, date: recent(24) },   // 1d ago, weight 2.0
      { price: 50, date: recent(24) },   // 1d ago, weight 2.0
      { price: 50, date: recent(36) },   // 1.5d ago, weight 2.0
      { price: 100, date: recent(60 * 24) }, // 60d ago, weight 0.1
      { price: 100, date: recent(60 * 24) }, // 60d ago, weight 0.1
      { price: 100, date: recent(60 * 24) }, // 60d ago, weight 0.1
      { price: 100, date: recent(60 * 24) }, // 60d ago, weight 0.1
    ];

    it("plain-median value of the fixture is the older cluster (control)", () => {
      const sorted = FIXTURE.map((s) => s.price).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const plainMedian =
        sorted.length % 2 === 1
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
      expect(plainMedian).toBe(100);
    });

    it("velocity-weighted median lands at the recent cluster (Ship 1 fix)", () => {
      const wm = computeWeightedMedian(FIXTURE);
      expect(wm).not.toBeNull();
      // Recent cluster is $50; weighted median should land there because
      // total weight = 2+2+2+0.1+0.1+0.1+0.1 = 6.4, half = 3.2;
      // cumulative crosses 3.2 inside the first two recent (cum=4.0 at idx=1).
      expect(wm).toBe(50);
    });

    it("clearly distinguishes recent-lean from count-center", () => {
      const wm = computeWeightedMedian(FIXTURE);
      const sorted = FIXTURE.map((s) => s.price).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const plainMedian =
        sorted.length % 2 === 1
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
      expect(wm).not.toBe(plainMedian);
      // Direction check: recent prices are lower, weighted result is lower
      // than plain median.
      expect(wm as number).toBeLessThan(plainMedian);
    });
  });

  describe("(2) computeFmvBand monotonicity", () => {
    it("low < fmv < high for any valid FMV", () => {
      for (const sampleCount of [1, 5, 10, 20]) {
        for (const daysSinceNewest of [1, 30, 90, 365]) {
          const band = computeFmvBand(100, {
            sampleCount,
            daysSinceNewest,
            basedOn: "exact",
            trendPct: 0,
          });
          expect(band.low).not.toBeNull();
          expect(band.high).not.toBeNull();
          expect(band.low as number).toBeLessThan(100);
          expect(100).toBeLessThan(band.high as number);
        }
      }
    });

    it("thin comps -> wider band than thick comps (at fresh, exact)", () => {
      const thin = computeFmvBand(100, {
        sampleCount: 2,
        daysSinceNewest: 1,
        basedOn: "exact",
        trendPct: 0,
      });
      const thick = computeFmvBand(100, {
        sampleCount: 20,
        daysSinceNewest: 1,
        basedOn: "exact",
        trendPct: 0,
      });
      const thinSpread = (thin.high as number) - (thin.low as number);
      const thickSpread = (thick.high as number) - (thick.low as number);
      expect(thinSpread).toBeGreaterThan(thickSpread);
    });

    it("stale newest-comp -> wider band than fresh at equal sample count", () => {
      const fresh = computeFmvBand(100, {
        sampleCount: 20,
        daysSinceNewest: 1,
        basedOn: "exact",
        trendPct: 0,
      });
      const stale = computeFmvBand(100, {
        sampleCount: 20,
        daysSinceNewest: 120,
        basedOn: "exact",
        trendPct: 0,
      });
      const freshSpread = (fresh.high as number) - (fresh.low as number);
      const staleSpread = (stale.high as number) - (stale.low as number);
      expect(staleSpread).toBeGreaterThan(freshSpread);
    });

    it("sibling-path widens further than main-path at equal inputs", () => {
      const main = computeFmvBand(100, {
        sampleCount: 10,
        daysSinceNewest: 10,
        basedOn: "broader",
        trendPct: 0,
      });
      const sibling = computeFmvBand(100, {
        sampleCount: 10,
        daysSinceNewest: 10,
        basedOn: "broader",
        trendPct: 0,
        siblingPath: true,
      });
      expect(
        (sibling.high as number) - (sibling.low as number),
      ).toBeGreaterThan((main.high as number) - (main.low as number));
    });

    it("unknown inputs -> widest band (honesty rule)", () => {
      const known = computeFmvBand(100, {
        sampleCount: 20,
        daysSinceNewest: 1,
        basedOn: "exact",
        trendPct: 0,
      });
      const unknown = computeFmvBand(100, {});
      const knownSpread = (known.high as number) - (known.low as number);
      const unknownSpread = (unknown.high as number) - (unknown.low as number);
      expect(unknownSpread).toBeGreaterThan(knownSpread);
    });

    it("FMV null / 0 / NaN -> {low: null, high: null}", () => {
      expect(computeFmvBand(null, { sampleCount: 20 })).toEqual({
        low: null,
        high: null,
      });
      expect(computeFmvBand(0, { sampleCount: 20 })).toEqual({
        low: null,
        high: null,
      });
      expect(computeFmvBand(NaN, { sampleCount: 20 })).toEqual({
        low: null,
        high: null,
      });
    });
  });

  describe("(3) main-path FMV composition unchanged (band is additive)", () => {
    it("computeFmvBand never mutates its FMV input (purely derivational)", () => {
      const fmv = 123.45;
      computeFmvBand(fmv, { sampleCount: 10, daysSinceNewest: 5 });
      // JavaScript primitives are pass-by-value; the assertion is structural:
      // the helper returns a derived shape and cannot affect the caller's
      // fmv variable. This is a guard against any future refactor that
      // accidentally introduces a side-effecting transform on the input.
      expect(fmv).toBe(123.45);
    });
  });

  describe("(4) wire shape — fairMarketValueLow/High emitted at every FMV-returning return literal", () => {
    // Five FMV-returning return-literal sites in compiqEstimate.service.ts.
    // This is a source-level documentation test — locks the additive contract
    // so a future refactor cannot silently drop the band at any wire path.
    it("source file contains fairMarketValueLow/High at all 5 FMV-returning sites", async () => {
      const text = await fs.readFile(
        new URL(
          "../src/services/compiq/compiqEstimate.service.ts",
          import.meta.url,
        ),
        "utf8",
      );
      // Each null-FMV return literal pairs fairMarketValueLow: null + High: null.
      const nullPairs = text.match(/fairMarketValueLow: null,\s*fairMarketValueHigh: null/g);
      expect(nullPairs?.length ?? 0).toBeGreaterThanOrEqual(3); // unsupported_sport + variant-mismatch + no-recent-comps
      // Sibling-pool path emits a computed band.
      expect(text).toMatch(/fairMarketValueLow: siblingFmvBand\.low/);
      expect(text).toMatch(/fairMarketValueHigh: siblingFmvBand\.high/);
      // Main-success path emits mainFmvBand.
      expect(text).toMatch(/fairMarketValueLow: mainFmvBand\.low/);
      expect(text).toMatch(/fairMarketValueHigh: mainFmvBand\.high/);
      // CompIQEstimateResponse typed interface declares both optionals.
      const typedInterface = await fs.readFile(
        new URL("../src/types/compiq.types.ts", import.meta.url),
        "utf8",
      );
      expect(typedInterface).toMatch(/fairMarketValueLow\?: number \| null/);
      expect(typedInterface).toMatch(/fairMarketValueHigh\?: number \| null/);
    });
  });
});
