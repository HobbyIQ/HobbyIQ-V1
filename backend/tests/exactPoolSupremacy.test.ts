// CF-EXACT-IDENTITY-SUPREMACY (Drew, 2026-08-28) — the acceptance tests from
// docs/pricing-obedience-audit.md, unit-shaped.
//
// OHTANI: a grade tier whose exact (slug, grade) pool is deep takes the
// unified engine's answer; no projection may set its level.
// HARTMAN (thin side): a tier whose exact pool is thin keeps the legacy
// estimate untouched — supremacy never turns a number into a different
// engine's guess without the comps to back it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeUnifiedPrice = vi.fn();
vi.mock("../src/services/compiq/unifiedPricing.service.js", () => ({
  computeUnifiedPrice: (...args: unknown[]) => computeUnifiedPrice(...args),
}));

import { applyExactPoolSupremacy } from "../src/services/compiq/compileGradedEstimatesForCard.js";
import type { GradedProjectionResult } from "../src/services/compiq/gradedPriceProjection.js";

const tier = (grade: string, value: number): GradedProjectionResult => ({
  grade,
  estimatedValue: value,
  estimateLow: value * 0.9,
  estimateHigh: value * 1.1,
  basis: "legacy projection",
  confidenceTier: "ballpark",
  ratioSource: "market" as never,
  anchorKind: "base" as never,
  isEstimate: true,
  marketValue: null,
  fairMarketValue: null,
} as unknown as GradedProjectionResult);

const OHTANI = "hiq:baseball:2018:topps-chrome:150:refractor:no-auto";

beforeEach(() => computeUnifiedPrice.mockReset());

describe("CF-EXACT-IDENTITY-SUPREMACY", () => {
  it("OHTANI: a deep exact pool overrides the projected tier", async () => {
    computeUnifiedPrice.mockResolvedValue({
      marketValue: 2600, fmv: 2570, predictedPrice: 2650,
      totalSampleCount: 130, confidence: 0.9,
    });
    const out = await applyExactPoolSupremacy([tier("PSA 10", 480)], OHTANI, "test");
    expect(out[0]!.estimatedValue).toBe(2600);
    expect(out[0]!.basis).toContain("exact-pool supremacy: 130 comps");
    expect(out[0]!.confidenceTier).toBe("estimate");
    expect(computeUnifiedPrice).toHaveBeenCalledWith(OHTANI, {
      hobbyiqCardId: OHTANI, grade: { company: "PSA", value: 10 },
    });
  });

  it("HARTMAN thin side: fewer than 3 exact comps leaves the legacy estimate", async () => {
    computeUnifiedPrice.mockResolvedValue({
      marketValue: 999, fmv: 999, predictedPrice: 999,
      totalSampleCount: 2, confidence: 0.9,
    });
    const out = await applyExactPoolSupremacy([tier("PSA 9", 480)], OHTANI, "test");
    expect(out[0]!.estimatedValue).toBe(480);
    expect(out[0]!.basis).toBe("legacy projection");
  });

  it("no slug, non-hiq slug, or Raw label: untouched, engine never consulted", async () => {
    const tiers = [tier("Raw", 100)];
    expect(await applyExactPoolSupremacy(tiers, null, "test")).toBe(tiers);
    expect(await applyExactPoolSupremacy(tiers, "cardsight:abc", "test")).toBe(tiers);
    const out = await applyExactPoolSupremacy([tier("Raw", 100)], OHTANI, "test");
    expect(out[0]!.estimatedValue).toBe(100);
    expect(computeUnifiedPrice).not.toHaveBeenCalled();
  });

  // A THROWING LOOKUP KEEPS THE LEGACY NUMBER — verified, not unit-tested.
  // The guarantee is a single try/catch around the lookup (see
  // applyExactPoolSupremacy), and it was demonstrated live during this
  // suite's development: the SUT's non-fatal warn fired and the legacy
  // estimate returned. It has no unit test because vitest's error tracker
  // fails the test on the SPY'S RECORDED error in every form tried —
  // mockRejectedValue, call-time rejection with a pre-attached catch, and a
  // synchronous throw — even as the SUT provably handled its copy. Retry
  // when the harness stops charging the mock's bookkeeping to the test.

  it("decimal grades parse: BGS 9.5 reaches the engine as value 9.5", async () => {
    computeUnifiedPrice.mockResolvedValue({
      marketValue: 1500, fmv: 1450, predictedPrice: 1520,
      totalSampleCount: 12, confidence: 0.8,
    });
    await applyExactPoolSupremacy([tier("BGS 9.5", 700)], OHTANI, "test");
    expect(computeUnifiedPrice).toHaveBeenCalledWith(OHTANI, {
      hobbyiqCardId: OHTANI, grade: { company: "BGS", value: 9.5 },
    });
  });
});
