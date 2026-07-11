/**
 * CF-MARKETVALUE-HONESTY (2026-06-09) — cannotPriceFromEst gate.
 *
 * The route builder swaps from isThinFromEst (sources only) to
 * cannotPriceFromEst (also catches the LIVE-source-but-pipeline-
 * couldn't-anchor cases: FMV ≤ 0, coverage=no_card, compsUsed<3).
 * When this returns true, marketTier / buyZone / holdZone / sellZone /
 * fairMarketValueLive / marketValue all emit null on the response —
 * iOS renders the no-estimate state instead of a misleading "$0".
 */
import { describe, it, expect } from "vitest";
import { __testing__ } from "../src/routes/compiq.routes";

const { cannotPriceFromEst } = __testing__;

function est(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "live",
    fairMarketValue: 250,
    compsUsed: 12,
    trendIQ: { coverage: "no_segment" },
    ...overrides,
  };
}

describe("cannotPriceFromEst", () => {
  it("false on a normal live response (FMV > 0, coverage=no_segment, 12 comps)", () => {
    expect(cannotPriceFromEst(est({}))).toBe(false);
  });

  // Existing thin-sources keep working — backward compat with isThinFromEst.
  for (const src of [
    "no-recent-comps",
    "out-of-scope",
    "catalog-miss",
    "upstream-timeout",
  ]) {
    it(`true when source = "${src}" (legacy thin-source)`, () => {
      expect(cannotPriceFromEst(est({ source: src }))).toBe(true);
    });
  }

  // CF-MARKETVALUE-HONESTY — new cases beyond the legacy gate.
  it("true when fairMarketValue is null", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: null }))).toBe(true);
  });

  it("true when fairMarketValue is undefined", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: undefined }))).toBe(true);
  });

  it("true when fairMarketValue is exactly 0 (the Trout-Gold bug)", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: 0 }))).toBe(true);
  });

  it("true when fairMarketValue is negative", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: -50 }))).toBe(true);
  });

  it("true when fairMarketValue is NaN", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: Number.NaN }))).toBe(true);
  });

  it("true when fairMarketValue is Infinity", () => {
    expect(cannotPriceFromEst(est({ fairMarketValue: Number.POSITIVE_INFINITY }))).toBe(true);
  });

  it("true when trendIQ.coverage === 'no_card' (Layer 2 missing)", () => {
    // The Trout-Gold case: 2 comps survive the parallel filter,
    // pipeline emits some number but cardTrajectory layer is null →
    // TrendIQ coverage = no_card. Refuse to surface as a real price.
    expect(cannotPriceFromEst(est({ trendIQ: { coverage: "no_card" } }))).toBe(true);
  });

  it("false when trendIQ.coverage is 'no_segment' (Layer 3 missing but Layer 2 present)", () => {
    expect(cannotPriceFromEst(est({ trendIQ: { coverage: "no_segment" } }))).toBe(false);
  });

  it("true when compsUsed < 3 (sub-threshold pool)", () => {
    expect(cannotPriceFromEst(est({ compsUsed: 0 }))).toBe(true);
    expect(cannotPriceFromEst(est({ compsUsed: 1 }))).toBe(true);
    expect(cannotPriceFromEst(est({ compsUsed: 2 }))).toBe(true);
  });

  it("false when compsUsed === 3 (threshold boundary, healthy FMV + coverage)", () => {
    expect(cannotPriceFromEst(est({ compsUsed: 3 }))).toBe(false);
  });

  it("Trout-Gold exact scenario: compsUsed=2, coverage=no_card, fmv=0 → true", () => {
    // Reproduces the bug observed in production (281512f live response):
    //   marketValue=$0, compsUsed/avail=2/2, coverage=no_card
    // ALL three guards fire — strongest possible signal.
    expect(
      cannotPriceFromEst(
        est({
          fairMarketValue: 0,
          compsUsed: 2,
          trendIQ: { coverage: "no_card" },
        }),
      ),
    ).toBe(true);
  });

  // CF-FAMILY-PROJECTION-COMPS-USED-HONESTY-EXTEND (2026-07-11) — bypass the
  // compsUsed<3 gate for projection + Tier 6/7 fallback sources. The user-
  // visible bug: Padparadscha Sapphire routed through product-family-
  // projection, engine returned fairMarketValue=$120, but response builder
  // nulled it because the parent product only had 1 comp. Same class as
  // the title-match-recovered pool bypass — the projection is derived from
  // math (parent median × family multiplier × parallel floor), not the
  // sub-threshold count itself.
  describe("projection-source bypass for compsUsed<3", () => {
    for (const src of [
      "product-family-projection",
      "parallel-floor-projection",
      "scarcity-prior-floor",
      "reference-catalog-baseline",
      "setdoc-baseline",
    ]) {
      it(`false when source = "${src}" and compsUsed=1 with valid FMV`, () => {
        expect(
          cannotPriceFromEst(
            est({
              source: src,
              fairMarketValue: 120,
              compsUsed: 1,
              trendIQ: { coverage: "no_segment" },
            }),
          ),
        ).toBe(false);
      });

      it(`false when source = "${src}" and compsUsed=0 with valid FMV (Tier 6/7 by design)`, () => {
        expect(
          cannotPriceFromEst(
            est({
              source: src,
              fairMarketValue: 45,
              compsUsed: 0,
              trendIQ: { coverage: "no_segment" },
            }),
          ),
        ).toBe(false);
      });

      it(`true when source = "${src}" but fairMarketValue is null (fmv guard still fires)`, () => {
        expect(
          cannotPriceFromEst(
            est({
              source: src,
              fairMarketValue: null,
              compsUsed: 1,
            }),
          ),
        ).toBe(true);
      });

      it(`true when source = "${src}" but fairMarketValue is 0 (fmv guard still fires)`, () => {
        expect(
          cannotPriceFromEst(
            est({
              source: src,
              fairMarketValue: 0,
              compsUsed: 1,
            }),
          ),
        ).toBe(true);
      });
    }

    it("Padparadscha exact reproduction — family-projection, parent 1 comp, FMV $120", () => {
      const padparadscha = {
        source: "product-family-projection",
        fairMarketValue: 120,
        fairMarketValueLow: 90,
        fairMarketValueHigh: 150,
        marketValue: 120,
        compsUsed: 1,
        compsAvailable: 1,
        confidence: { pricingConfidence: 55 },
        trendIQ: { coverage: "no_segment" },
      } as Record<string, unknown>;
      expect(cannotPriceFromEst(padparadscha)).toBe(false);
    });
  });
});
