// CF-FIRST-RUN (Drew, 2026-09-02). The value moment, pinned against
// fixture holdings.
//
// The funnel's whole product is this render, and the ways it can be wrong
// are the ways that matter most: showing a cost basis as a value, showing
// an estimate as though it were observed, or hiding a rung we do not
// recognise. Each fixture below is a holding shaped exactly as the wire
// sends it.
import { describe, expect, it } from "vitest";
import {
  UNPRICED_COPY,
  firstValueRender,
  howWePriceLine,
} from "./firstValue";
import type { PortfolioHolding, PricingEnvelope } from "./api";

function envelope(over: {
  value?: number | null;
  valueSource?: PricingEnvelope["headline"]["valueSource"];
  quantity?: number;
  ladderRung?: string | null;
  compsUsed?: number | null;
  pricingSource?: PricingEnvelope["provenance"]["pricingSource"];
}): PricingEnvelope {
  return {
    headline: {
      value: over.value ?? null,
      valueSource: over.valueSource ?? "unpriced",
      perUnit: over.value ?? null,
      quantity: over.quantity ?? 1,
    },
    observed: { fairMarketValue: over.value ?? null, total: null },
    estimate: null,
    method: {
      kind: "unknown",
      label: "—",
      ladderRung: over.ladderRung ?? null,
      compsUsed: over.compsUsed ?? null,
    },
    confidence: { pricing: null, liquidity: null, timing: null },
    predicted: null,
    trend: { trendIQ: null, movementDirection: null, broaderTrendPctPerMonth: null, updatedAt: null },
    bands: null,
    provenance: {
      vendor: null, vendorUpdatedAt: null,
      pricingSource: over.pricingSource ?? null, pricingSourceMeta: null,
      nearestGradedAnchor: null, lastSaleSurface: null, modelExpectation: null, modelSignal: null,
    },
    quality: { score: null, flaggedCompCount: null, sources: [], freshness: "Live", lastPricedAt: null },
    composite: null,
    population: null,
  };
}

/** A freshly-added PSA 10 with five real sales of this exact card. The
 *  happy path the funnel is designed around. */
const observedHolding: PortfolioHolding = {
  id: "h-observed",
  quantity: 1,
  playerName: "Eric Hartman",
  cardYear: 2026,
  product: "Bowman Chrome",
  cardNumber: "CPA-EHA",
  gradeCompany: "PSA",
  gradeValue: 10,
  purchasePrice: 240,
  pricing: envelope({
    value: 415,
    valueSource: "observed",
    ladderRung: "exact-pool-projection",
    compsUsed: 5,
    pricingSource: "unified-pricing",
  }),
};

/** Priced only off sibling parallels — a real number, but an ESTIMATE,
 *  and the chip and copy have to say so. */
const estimateHolding: PortfolioHolding = {
  ...observedHolding,
  id: "h-estimate",
  pricing: envelope({
    value: 88,
    valueSource: "estimated",
    ladderRung: "sibling-parallel",
    pricingSource: "sibling-estimate",
  }),
};

/** The engine declined. The envelope is present and says so, which means
 *  the legacy flats must NOT be consulted. */
const unpricedHolding: PortfolioHolding = {
  ...observedHolding,
  id: "h-unpriced",
  fairMarketValue: 999,   // legacy flat that must be ignored
  pricing: envelope({ value: null, valueSource: "unpriced", ladderRung: "no-basis" }),
};

/** Only a cost basis exists. The classic bug: rendering $1539 of cost as
 *  though it were $1539 of value. */
const costProxyHolding: PortfolioHolding = {
  ...observedHolding,
  id: "h-cost-proxy",
  totalCostBasis: 1539,
  currentValue: 1539,
  pricing: envelope({ value: 1539, valueSource: "cost-proxy" }),
};

describe("the value moment shows the real number", () => {
  it("renders an observed value with its observed provenance", () => {
    const r = firstValueRender(observedHolding);
    expect(r.value).toBe(415);
    expect(r.unpriced).toBe(false);
    expect(r.provenance.kind).toBe("observed");
    expect(r.howWePrice).toContain("projected from 5 sales of this card");
  });

  it("multiplies per-unit value by quantity, as the portfolio does", () => {
    const two = { ...observedHolding, quantity: 2, pricing: envelope({
      value: 415, valueSource: "observed", quantity: 2, ladderRung: "exact-pool-projection",
    }) };
    expect(firstValueRender(two).value).toBe(830);
  });

  it("says ESTIMATE for a fallback rung — never dresses one as observed", () => {
    const r = firstValueRender(estimateHolding);
    expect(r.value).toBe(88);
    expect(r.provenance.kind).toBe("estimate");
    expect(r.howWePrice).toContain("estimate from sibling parallels");
  });
});

describe("it never invents value", () => {
  it("shows no number, and says why, when the engine declined", () => {
    const r = firstValueRender(unpricedHolding);
    expect(r.value).toBeNull();
    expect(r.unpriced).toBe(true);
    expect(r.howWePrice).toBe(UNPRICED_COPY);
  });

  it("does not fall through to a legacy flat when the envelope declined", () => {
    // fairMarketValue: 999 is on the fixture and must not appear.
    expect(firstValueRender(unpricedHolding).value).not.toBe(999);
  });

  it("NEVER renders a cost basis as a value", () => {
    const r = firstValueRender(costProxyHolding);
    expect(r.value).toBeNull();
    expect(r.unpriced).toBe(true);
    expect(r.value).not.toBe(1539);
  });
});

describe("a cold pool is not the price", () => {
  it("adds the speculation line when the newest comp is past the stale line", () => {
    const r = firstValueRender(observedHolding, 90);
    expect(r.staleLong).not.toBeNull();
    // The shipped wording from lib/rung.ts, not a paraphrase.
    expect(r.howWePrice).toContain("old prints aren't fair value today");
    // The rung still says which pool the number came from.
    expect(r.howWePrice).toContain("projected from 5 sales of this card");
  });

  it("says nothing about age for a fresh pool", () => {
    const r = firstValueRender(observedHolding, 3);
    expect(r.staleLong).toBeNull();
    expect(r.howWePrice).not.toContain("weeks ago");
  });

  it("says nothing about age when the age is unknown", () => {
    expect(firstValueRender(observedHolding, null).staleLong).toBeNull();
    expect(firstValueRender(observedHolding, undefined).staleLong).toBeNull();
  });
});

describe("an unrecognised rung is never hidden", () => {
  it("shows the unknown rung rather than implying a good one", () => {
    const odd: PortfolioHolding = {
      ...observedHolding,
      pricing: envelope({ value: 50, valueSource: "observed", ladderRung: "rung-from-the-future" }),
    };
    const r = firstValueRender(odd);
    expect(r.provenance.kind).toBe("unknown");
    expect(r.howWePrice).toContain("rung-from-the-future");
  });

  it("reports a missing rung as missing", () => {
    const bare: PortfolioHolding = {
      ...observedHolding,
      pricing: envelope({ value: 50, valueSource: "observed", ladderRung: null }),
    };
    expect(firstValueRender(bare).provenance.kind).toBe("unknown");
  });
});

describe("the how-we-price line", () => {
  it("leads with the FMV doctrine — the projected next sale, not an average", () => {
    const line = howWePriceLine("projected from 5 sales of this card", null);
    expect(line).toContain("prices the next sale");
    expect(line).toContain("not the average of old ones");
  });

  it("appends the staleness sentence verbatim when there is one", () => {
    const stale = "Last direct sale was 9 weeks ago — old prints aren't fair value today.";
    expect(howWePriceLine("from the last sale of this card, trend-adjusted", stale))
      .toContain(stale);
  });
});
