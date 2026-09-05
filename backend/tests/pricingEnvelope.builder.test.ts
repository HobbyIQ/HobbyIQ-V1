// CF-PRICING-ENVELOPE-BUILDER — unit tests for the canonical pricing
// envelope. Locks the shape iOS + web bind to, plus the field-derivation
// invariants (headline fallback ladder, band computation, method kind
// mapping, confidence tier coercion).

import { describe, it, expect } from "vitest";
import { buildPricingEnvelope, resolvePricingConfidence } from "../src/services/portfolioiq/pricingEnvelope.builder.js";
import { scalePricingConfidence } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

// Minimal holding factory — enough to exercise the builder without
// dragging in the full 300-field PortfolioHolding type. `as any` cast
// lets us skip identity/EBay/etc. plumbing the envelope doesn't touch.
function fixture(overrides: Partial<PortfolioHolding> & Record<string, unknown> = {}): PortfolioHolding {
  return {
    id: "h1",
    quantity: 1,
    playerName: "Test Player",
    cardYear: 2026,
    ...overrides,
  } as PortfolioHolding;
}

describe("buildPricingEnvelope", () => {
  it("observed path: headline.value = fmvPerUnit, valueSource='observed'", () => {
    const h = fixture({ fairMarketValue: 500 });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: 500,
      displayable: { value: 500, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.headline.value).toBe(500);
    expect(env.headline.valueSource).toBe("observed");
    expect(env.observed.fairMarketValue).toBe(500);
    expect(env.observed.total).toBe(500);
    expect(env.bands).not.toBeNull();
    expect(env.bands!.quickSale).toBeCloseTo(500 * 0.85);
    expect(env.bands!.premium).toBeCloseTo(500 * 1.15);
  });

  it("estimated path: headline.valueSource='estimated' when fmvPerUnit is null but estimatedValue is set", () => {
    const h = fixture({
      estimatedValue: 2988,
      estimateLow: 1622.50,
      estimateHigh: 2750,
      estimateConfidence: "rough" as any,
      estimateBasis: "Grade estimated from 2 raw sales × PSA 9 multiplier (1.10×)",
      isEstimate: true,
      valuationStatus: "estimated",
    });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: null,
      displayable: { value: 2988, source: "estimated" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.headline.valueSource).toBe("estimated");
    expect(env.headline.value).toBe(2988);
    expect(env.estimate).not.toBeNull();
    expect(env.estimate!.value).toBe(2988);
    expect(env.estimate!.confidence).toBe("rough");
    expect(env.estimate!.range).toEqual({ low: 1622.50, high: 2750 });
    expect(env.observed.fairMarketValue).toBeNull();
    // bands null when fmvPerUnit is null (estimates don't drive bands)
    expect(env.bands).toBeNull();
  });

  it("unpriced fallback: valueSource='cost-proxy' when only purchasePrice available", () => {
    const h = fixture({ purchasePrice: 100 });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: null,
      displayable: { value: null, source: null },
      quantity: 1,
      freshness: "Needs refresh",
    });
    expect(env.headline.valueSource).toBe("cost-proxy");
    expect(env.headline.value).toBe(100);
    expect(env.estimate).toBeNull();
    expect(env.observed.fairMarketValue).toBeNull();
  });

  it("truly unpriced: valueSource='unpriced' when nothing available", () => {
    const h = fixture({});
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: null,
      displayable: { value: null, source: null },
      quantity: 1,
      freshness: "Needs refresh",
    });
    expect(env.headline.valueSource).toBe("unpriced");
    expect(env.headline.value).toBeNull();
  });

  describe("method mapping", () => {
    it("our-pool + direct-slug → kind=direct-comp", () => {
      const h = fixture({
        pricingSource: "our-pool",
        pricingSourceMeta: { slug: "hiq:...", method: "direct-slug", compsUsed: 5 },
      });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: 100,
        displayable: { value: 100, source: "observed" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.method.kind).toBe("direct-comp");
      expect(env.method.label).toBe("Direct comps");
      expect(env.method.ladderRung).toBe("direct-slug");
      expect(env.method.compsUsed).toBe(5);
    });

    it("our-pool + cross-setkey → kind=cross-parallel", () => {
      const h = fixture({
        pricingSource: "our-pool",
        pricingSourceMeta: { slug: "hiq:...", method: "cross-setkey", compsUsed: 3 },
      });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: 200,
        displayable: { value: 200, source: "observed" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.method.kind).toBe("cross-parallel");
    });

    it("our-pool + grade-cross-raw → kind=grade-cross-raw", () => {
      const h = fixture({
        pricingSource: "our-pool",
        pricingSourceMeta: { slug: "hiq:...", method: "grade-cross-raw", compsUsed: 2 },
      });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: null,
        displayable: { value: 2988, source: "estimated" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.method.kind).toBe("grade-cross-raw");
      expect(env.method.label).toBe("Raw × grade multiplier");
    });

    it("legacy-engine → kind=legacy-engine", () => {
      const h = fixture({ pricingSource: "legacy-engine" });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: 100,
        displayable: { value: 100, source: "observed" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.method.kind).toBe("legacy-engine");
    });

    it("no pricingSource + nearestGradedAnchor present → kind=ladder-fallback", () => {
      const h = fixture({
        nearestGradedAnchor: { grade: "PSA 9", price: 500, daysOld: 10, sampleSize: 3, confidence: 0.6 },
      });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: null,
        displayable: { value: 500, source: "estimated" },
        quantity: 1,
        freshness: "Updated Today",
      });
      expect(env.method.kind).toBe("ladder-fallback");
      expect(env.method.compsUsed).toBe(3);
    });

    it("no signals at all → kind=unknown", () => {
      const h = fixture({});
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: null,
        displayable: { value: null, source: null },
        quantity: 1,
        freshness: "Needs refresh",
      });
      expect(env.method.kind).toBe("unknown");
    });
  });

  describe("confidence tier coercion", () => {
    it("passes through valid tiers", () => {
      for (const tier of ["estimate", "rough", "ballpark", "no-data"] as const) {
        const h = fixture({ estimatedValue: 100, estimateConfidence: tier as any });
        const env = buildPricingEnvelope(h, {
          fmvPerUnit: null,
          displayable: { value: 100, source: "estimated" },
          quantity: 1,
          freshness: "Live",
        });
        expect(env.estimate?.confidence).toBe(tier);
      }
    });

    it("maps legacy 'insufficient' → 'no-data'", () => {
      const h = fixture({ estimatedValue: 100, estimateConfidence: "insufficient" as any });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: null,
        displayable: { value: 100, source: "estimated" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.estimate?.confidence).toBe("no-data");
    });

    it("returns null for unknown tier strings", () => {
      const h = fixture({ estimatedValue: 100, estimateConfidence: "garbage" as any });
      const env = buildPricingEnvelope(h, {
        fmvPerUnit: null,
        displayable: { value: 100, source: "estimated" },
        quantity: 1,
        freshness: "Live",
      });
      expect(env.estimate?.confidence).toBeNull();
    });
  });

  it("bands: buyZone/holdZone/sellZone are ordered tuples derived from fmvPerUnit", () => {
    const env = buildPricingEnvelope(fixture({}), {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.bands).not.toBeNull();
    const b = env.bands!;
    expect(b.buyZone![0]).toBeLessThan(b.buyZone![1]);
    expect(b.holdZone![0]).toBeLessThan(b.holdZone![1]);
    expect(b.sellZone![0]).toBeLessThan(b.sellZone![1]);
    // Zones are contiguous: buy ends at hold starts, hold ends at sell starts
    expect(b.buyZone![1]).toBe(b.holdZone![0]);
    expect(b.holdZone![1]).toBe(b.sellZone![0]);
  });

  it("provenance: passes through nearestGradedAnchor, lastSaleSurface, modelExpectation, modelSignal", () => {
    const h = fixture({
      nearestGradedAnchor: { grade: "PSA 10", price: 1000, daysOld: 5, sampleSize: 8, confidence: 0.8 },
      lastSaleSurface: { price: 500, date: "2026-07-01", compCount: 1 },
      modelExpectation: { forwardProjection: 550 },
      modelSignal: { positionSignal: "up" },
      sourceVendor: "cardhedge",
      sourceVendorUpdatedAt: "2026-07-31T00:00:00Z",
    });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: 500,
      displayable: { value: 500, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.provenance.nearestGradedAnchor).toEqual({
      grade: "PSA 10", price: 1000, daysOld: 5, sampleSize: 8, confidence: 0.8,
    });
    expect(env.provenance.lastSaleSurface).toEqual({ price: 500, date: "2026-07-01", compCount: 1 });
    expect(env.provenance.modelExpectation).toEqual({ forwardProjection: 550 });
    expect(env.provenance.modelSignal).toEqual({ positionSignal: "up" });
    expect(env.provenance.vendor).toBe("cardhedge");
  });

  it("predicted: returns null when no prediction fields set", () => {
    const env = buildPricingEnvelope(fixture({}), {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.predicted).toBeNull();
  });

  it("predicted: populates from flat fields when set", () => {
    const h = fixture({
      predictedPrice: 550,
      predictedPriceLow: 500,
      predictedPriceHigh: 600,
      predictedPriceMechanism: "regression",
      predictedPriceUpdatedAt: "2026-07-30T12:00:00Z",
    });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: 500,
      displayable: { value: 500, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.predicted).not.toBeNull();
    expect(env.predicted!.value).toBe(550);
    expect(env.predicted!.range).toEqual({ low: 500, high: 600 });
    expect(env.predicted!.mechanism).toBe("regression");
    expect(env.predicted!.updatedAt).toBe("2026-07-30T12:00:00Z");
    // attribution derived from bare mechanism string when full object absent
    expect(env.predicted!.attribution).toEqual({ mechanism: "regression" });
  });

  it("trend: coerces movementDirection to enum, null for unknown values", () => {
    const h = fixture({ movementDirection: "up" });
    const env = buildPricingEnvelope(h, {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.trend.movementDirection).toBe("up");

    const h2 = fixture({ movementDirection: "sideways" as any });
    const env2 = buildPricingEnvelope(h2, {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env2.trend.movementDirection).toBeNull();
  });

  it("composite and population are null when absent from holding (v3 backfill hasn't reached)", () => {
    const env = buildPricingEnvelope(fixture({}), {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.composite).toBeNull();
    expect(env.population).toBeNull();
  });

  it("quality.freshness pass-through matches caller-supplied value", () => {
    for (const f of ["Live", "Updated Today", "Yesterday", "Needs refresh"] as const) {
      const env = buildPricingEnvelope(fixture({}), {
        fmvPerUnit: 100,
        displayable: { value: 100, source: "observed" },
        quantity: 1,
        freshness: f,
      });
      expect(env.quality.freshness).toBe(f);
    }
  });

  it("quantity > 1: observed.total = fmvPerUnit × quantity", () => {
    const env = buildPricingEnvelope(fixture({}), {
      fmvPerUnit: 100,
      displayable: { value: 100, source: "observed" },
      quantity: 3,
      freshness: "Live",
    });
    expect(env.observed.total).toBe(300);
    expect(env.headline.quantity).toBe(3);
    // Per-unit value stays per-unit — total only in observed.total
    expect(env.headline.perUnit).toBe(100);
    expect(env.headline.value).toBe(100);
  });
});


// ─── CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03) ────────────────────────
//
// `confidence.pricing` used to be filled from the flat `holding.confidence`
// field. The canonical/unified writer never sets that field, so on a
// unified-priced holding the envelope published whatever a previous legacy
// reprice had left behind — under a name promising a pricing confidence.
//
// The engine's pricing confidence now rides in pricingSourceMeta, stamped
// by the writer that decided the price. The envelope must prefer it, and
// must not present the flat field as a pricing confidence on rows the
// legacy path did not price.
describe("confidence.pricing carries the engine's pricing confidence", () => {
  const inputs = {
    fmvPerUnit: 121,
    displayable: { value: 121, source: "observed" as const },
    quantity: 1,
    freshness: "Live" as const,
  };

  it("prefers the engine's pricing confidence over the flat field", () => {
    const env = buildPricingEnvelope(fixture({
      fairMarketValue: 121,
      pricingSource: "unified-pricing",
      // The matcher is certain; the evidence is thin. The envelope must
      // publish the evidence figure.
      confidence: 1,
      pricingSourceMeta: {
        slug: "hiq:baseball:1987:topps-traded-tiffany:70t",
        method: "exact-pool-projection",
        compsUsed: 3,
        confidence: 0.37,
      },
    }), inputs);
    expect(env.confidence.pricing).toBe(0.37);
    expect(env.provenance.pricingSourceMeta?.confidence).toBe(0.37);
  });

  it("does not publish a unified holding's flat confidence as a pricing confidence", () => {
    const env = buildPricingEnvelope(fixture({
      fairMarketValue: 121,
      pricingSource: "unified-pricing",
      confidence: 1,
      pricingSourceMeta: {
        slug: "s", method: "exact-pool-projection", compsUsed: 3,
      },
    }), inputs);
    expect(env.confidence.pricing).toBeNull();
    expect(env.provenance.pricingSourceMeta?.confidence).toBeNull();
  });

  it("still reads the flat field for the legacy path that writes it", () => {
    const env = buildPricingEnvelope(fixture({
      fairMarketValue: 121,
      pricingSource: "legacy-engine",
      confidence: 0.64,
    }), inputs);
    expect(env.confidence.pricing).toBe(0.64);
  });

  it("treats a pre-CF holding with no pricingSource as legacy-priced", () => {
    const env = buildPricingEnvelope(fixture({ fairMarketValue: 121, confidence: 0.5 }), inputs);
    expect(env.confidence.pricing).toBe(0.5);
  });

  it("rejects an out-of-range confidence rather than publishing it", () => {
    // The legacy writer saturates a 0..100 input at 1 via Math.min; a raw
    // 0..100 value reaching here is not a 0..1 confidence.
    const env = buildPricingEnvelope(fixture({
      fairMarketValue: 121,
      pricingSource: "unified-pricing",
      pricingSourceMeta: { slug: "s", method: "m", compsUsed: 1, confidence: 64 },
    }), inputs);
    expect(env.confidence.pricing).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CF-PRICING-CONFIDENCE-SCALE (2026-09-03)
//
// portfolioStore's holding writer used to do `Math.min(1, pricingConfidence)`
// on a 0..100 input instead of dividing by 100, so every confidence at or
// above 1 persisted as exactly 1.0. That is the origin of the flat-1.0
// population (17 of 43 holdings in Drew's portfolio) and, because the sell
// signal read that same flat field, of "Pricing confidence on this card is
// 100%" on cards whose price was barely evidenced.
// ─────────────────────────────────────────────────────────────────────────

describe("scalePricingConfidence: the 0..100 -> 0..1 contract", () => {
  it("divides by 100 — 37 becomes 0.37, not 1", () => {
    expect(scalePricingConfidence(37)).toBeCloseTo(0.37, 10);
  });

  it("100 becomes 1.0 (the top of the scale, not a saturation artifact)", () => {
    expect(scalePricingConfidence(100)).toBe(1);
  });

  it("does NOT saturate mid-scale values — 91 and 37 stay distinct", () => {
    // The defect: Math.min(1, 91) === Math.min(1, 37) === 1.
    expect(scalePricingConfidence(91)).toBeCloseTo(0.91, 10);
    expect(scalePricingConfidence(91)).not.toBe(scalePricingConfidence(37));
  });

  it("an already-sub-1 input is NOT re-interpreted as already-scaled", () => {
    // The only producer emitting a sub-1 value is the variant-mismatch branch
    // (compiqEstimate.service.ts ~6007, `pricingConfidence: 0.2`), which means
    // "almost no confidence". Scaling it to 0.002 is the honest reading; magic
    // scale-sniffing would promote it to 20% and reintroduce a magnitude-
    // dependent bug of exactly the kind this replaces.
    expect(scalePricingConfidence(0.37)).toBeCloseTo(0.0037, 10);
    expect(scalePricingConfidence(0.2)).toBeCloseTo(0.002, 10);
  });

  it("clamps out of range and rejects non-numbers as null", () => {
    expect(scalePricingConfidence(140)).toBe(1);
    expect(scalePricingConfidence(-5)).toBe(0);
    expect(scalePricingConfidence(0)).toBe(0);
    expect(scalePricingConfidence(null)).toBeNull();
    expect(scalePricingConfidence(undefined)).toBeNull();
    expect(scalePricingConfidence("55")).toBeNull();
    expect(scalePricingConfidence(NaN)).toBeNull();
  });
});

describe("resolvePricingConfidence: pricing confidence, never a match score", () => {
  it("prefers the engine's pricingSourceMeta.confidence over the flat field", () => {
    const h = fixture({
      confidence: 1.0, // saturated identity/match score
      pricingSource: "unified-pricing",
      pricingSourceMeta: { slug: "hiq:x", method: "exact-pool", compsUsed: 9, confidence: 0.30 },
    });
    expect(resolvePricingConfidence(h as any)).toBe(0.30);
  });

  it("returns null — not the flat field — for a unified row with no engine confidence", () => {
    const h = fixture({
      confidence: 1.0,
      pricingSource: "unified-pricing",
      pricingSourceMeta: { slug: "hiq:x", method: "exact-pool", compsUsed: 9 },
    });
    expect(resolvePricingConfidence(h as any)).toBeNull();
  });

  it("falls back to the flat field only for legacy-engine-priced rows", () => {
    expect(resolvePricingConfidence(fixture({ confidence: 0.62, pricingSource: "legacy-engine" }) as any)).toBe(0.62);
    // Pre-CF rows carry no pricingSource at all; computeEstimate priced them.
    expect(resolvePricingConfidence(fixture({ confidence: 0.62 }) as any)).toBe(0.62);
  });

  it("rejects an out-of-unit flat value rather than passing it through", () => {
    expect(resolvePricingConfidence(fixture({ confidence: 62, pricingSource: "legacy-engine" }) as any)).toBeNull();
  });
});

// ─── CF-WITHHELD-REACHES-THE-GLASS (Drew, 2026-09-05) ──────────────────
//
// The refusal block must survive the envelope boundary. Before this, the
// builder read only {slug, method, compsUsed} off `pricingSourceMeta`, so a
// withheld holding reached every client as an indistinguishable null and the
// UI could say nothing truer than "—". These pin the block through.
describe("provenance.withheld: a refusal reaches the client", () => {
  const floor = {
    reason: "cost-basis-floor" as const,
    blockingId: "hiq:1989-opc-griffey-1",
    blockingCount: 4,
    proposed: 2,
    retained: 29.45,
    retentionRefused: null,
    retainedRung: "exact-pool-last-sale",
  };

  it("carries every field of a cost-basis-floor refusal", () => {
    const env = buildPricingEnvelope(
      fixture({ pricingSourceMeta: { slug: "hiq:x", method: "withheld", compsUsed: 4, withheld: floor } }),
      { fmvPerUnit: null, displayable: { value: null, source: "unpriced" }, quantity: 1, freshness: "Live" },
    );
    // The refused market number is the evidence that makes the refusal
    // legible: "market shows $2, held below 15% of your $29.45 basis".
    expect(env.provenance.withheld).toEqual(floor);
  });

  it("survives when the published-price projection is absent (no pool at all)", () => {
    // identity-not-in-catalog computes nothing, so slug/method/compsUsed are
    // missing and `pricingSourceMeta` projects to null. The refusal must NOT
    // be gated on the published shape — that gating is what hid it.
    const env = buildPricingEnvelope(
      fixture({ pricingSourceMeta: { withheld: { reason: "identity-not-in-catalog" } } }),
      { fmvPerUnit: null, displayable: { value: null, source: "unpriced" }, quantity: 1, freshness: "Live" },
    );
    expect(env.provenance.pricingSourceMeta).toBeNull();
    expect(env.provenance.withheld?.reason).toBe("identity-not-in-catalog");
    // Nothing was computed, so there is no refused number. Null SAYS that.
    expect(env.provenance.withheld?.proposed).toBeNull();
  });

  it("carries all four reasons distinctly — they are four different fixes", () => {
    for (const reason of ["cost-basis-floor", "no-checklist-match", "identity-not-in-catalog", "pool-migrating"] as const) {
      const env = buildPricingEnvelope(
        fixture({ pricingSourceMeta: { withheld: { reason } } }),
        { fmvPerUnit: null, displayable: { value: null, source: "unpriced" }, quantity: 1, freshness: "Live" },
      );
      expect(env.provenance.withheld?.reason).toBe(reason);
    }
  });

  it("a published row claims no refusal", () => {
    const env = buildPricingEnvelope(fixture({ fairMarketValue: 500 }), {
      fmvPerUnit: 500,
      displayable: { value: 500, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(env.provenance.withheld).toBeNull();
  });

  it("refuses an unrecognised reason rather than inventing a cause", () => {
    // A vocabulary the client cannot render is worse than silence: it would
    // paint an explanation panel with no explanation in it.
    const env = buildPricingEnvelope(
      fixture({ pricingSourceMeta: { withheld: { reason: "some-future-reason", proposed: 10 } } }),
      { fmvPerUnit: null, displayable: { value: null, source: "unpriced" }, quantity: 1, freshness: "Live" },
    );
    expect(env.provenance.withheld).toBeNull();
  });

  it("drops malformed numerics without dropping the refusal", () => {
    const env = buildPricingEnvelope(
      fixture({ pricingSourceMeta: { withheld: { reason: "pool-migrating", proposed: "12", blockingCount: NaN, blockingId: "" } } }),
      { fmvPerUnit: null, displayable: { value: null, source: "unpriced" }, quantity: 1, freshness: "Live" },
    );
    expect(env.provenance.withheld?.reason).toBe("pool-migrating");
    expect(env.provenance.withheld?.proposed).toBeNull();
    expect(env.provenance.withheld?.blockingCount).toBeNull();
    expect(env.provenance.withheld?.blockingId).toBeNull();
  });

  // ADDITIVE CONTRACT PIN. An old client destructures the fields it knows and
  // must be unaffected by the new one. This is the guarantee that lets the
  // wire change ship ahead of every consumer.
  it("is additive: the pre-existing provenance shape is untouched", () => {
    const env = buildPricingEnvelope(
      fixture({
        pricingSource: "our-pool",
        pricingSourceMeta: { slug: "hiq:x", method: "direct-slug", compsUsed: 7, confidence: 0.8, withheld: floor },
      }),
      { fmvPerUnit: 100, displayable: { value: 100, source: "observed" }, quantity: 1, freshness: "Live" },
    );
    expect(env.provenance.pricingSourceMeta).toEqual({
      slug: "hiq:x",
      method: "direct-slug",
      compsUsed: 7,
      confidence: 0.8,
    });
    expect(env.provenance.pricingLabels).toEqual([]);
    expect(env.provenance.selfAnchored).toBeNull();
  });
});
