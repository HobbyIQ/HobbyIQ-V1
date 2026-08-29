// CF-OBSERVED-NEEDS-COMPS (2026-08-22) — a broad rung must clear a comp floor
// before its number is published as an OBSERVED fair market value.
//
// THE BUG. priceHoldingFromOurPool classified any rung in OBSERVED_RUNGS as
// observed regardless of how many comps backed it, and set
// estimateConfidence: null while the comment above it claimed the number
// carried "lower confidence". The tier was computed and thrown away, so
// nothing downstream could tell a 50-comp direct hit from a 1-comp reach.
//
// Live case — 2024 Bowman Draft Cam Caminiti #CPA-CC Blue Refractor /150,
// cost $205.40. That parallel's partition holds ZERO comps, so cross-setkey
// fired, found exactly one sale under a different setKey, and published $4.99
// as an observed FMV. The card's own siblings were in the pool the whole time:
//
//     base:auto              7 comps   $39-62
//     refractor:auto         5 comps   $38-58
//     purple-refractor /250  2 comps   $56-128
//     green-lava /99         1 comp    $113.50
//
// Cheapest real sale of that card in ANY parallel: $37. The dashboard rendered
// -97.6% P&L against cost off one stray comp. A portfolio sweep found four
// holdings in this state, three of them worse than -95%: $688 of cost basis
// showing as $25.
//
// THIS FILE PINS:
//   1. A broad rung under the floor is ESTIMATED, not observed — and still
//      returns its value, because we do hold evidence and blanking hides it.
//   2. A broad rung at or above the floor is observed.
//   3. direct-slug is exempt. One sale of the EXACT card is thin but it is
//      genuinely that card.
//   4. Confidence rides along on BOTH paths. Returning observed with a null
//      tier is what made a 1-comp reach indistinguishable from a 50-comp hit.
//   5. The estimate path carries a band, so the UI can render a range.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const computeHobbyIqFmv = vi.fn();

vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", () => ({
  computeHobbyIqFmv: (...args: unknown[]) => computeHobbyIqFmv(...args),
}));

// D12a: the pinned slug must be a catalog row; it is, here.
vi.mock("../src/services/catalog/catalogMatcher.service.js", () => ({
  catalogSlugIfExists: async (slug: string) => slug,
}));

const SLUG = "hiq:baseball:2024:bowman-draft:cpa-cc:blue-refractor:auto";

const holding = () =>
  ({
    id: "h1",
    hobbyiqCardId: SLUG,
    gradeCompany: null,
    gradeValue: null,
  }) as never;

/** The FMV service's reply for a given rung + comp count. */
function fmvResult(method: string, compCount: number, fmv = 4.99) {
  return {
    fmv,
    method,
    compCount,
    confidence: 0.5,
    min: null,
    max: null,
    basisNote: `priced via ${method} from ${compCount} comp(s)`,
  };
}

async function priceIt() {
  const mod = await import("../src/services/portfolioiq/priceFromOurPool.service.js");
  return mod.priceHoldingFromOurPool(holding());
}

beforeEach(() => {
  vi.resetModules();
  computeHobbyIqFmv.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CF-OBSERVED-NEEDS-COMPS", () => {
  it("does NOT publish a single cross-setkey comp as observed", async () => {
    // The exact Caminiti case.
    computeHobbyIqFmv.mockResolvedValue(fmvResult("cross-setkey", 1, 4.99));
    const res = await priceIt();

    expect(res).not.toBeNull();
    expect(res!.valuationStatus).toBe("estimated");
    expect(res!.fairMarketValue).toBeNull();
    // The number still reaches the user — we do hold evidence, and blanking
    // the card would hide that.
    expect(res!.estimatedValue).toBe(4.99);
    expect(res!.compsUsed).toBe(1);
  });

  it("still refuses at two comps, one short of the floor", async () => {
    // The Guedez case: 2 comps, $12.42 against a $295.53 cost.
    computeHobbyIqFmv.mockResolvedValue(fmvResult("cross-setkey", 2, 12.42));
    const res = await priceIt();
    expect(res!.valuationStatus).toBe("estimated");
  });

  it("publishes a broad rung as observed once it clears the floor", async () => {
    computeHobbyIqFmv.mockResolvedValue(fmvResult("cross-setkey", 3, 45));
    const res = await priceIt();

    expect(res!.valuationStatus).toBe("observed");
    expect(res!.fairMarketValue).toBe(45);
    expect(res!.estimatedValue).toBeNull();
  });

  it("exempts direct-slug — one sale of the EXACT card still counts", async () => {
    // This is the whole distinction. A single sale of the card itself is thin
    // evidence about the right card; a single sale from another set is good
    // evidence about the wrong one.
    computeHobbyIqFmv.mockResolvedValue(fmvResult("direct-slug", 1, 52));
    const res = await priceIt();

    expect(res!.valuationStatus).toBe("observed");
    expect(res!.fairMarketValue).toBe(52);
  });

  it("carries the confidence tier on the OBSERVED path", async () => {
    // Previously hardcoded null here, which is what made a 1-comp reach
    // indistinguishable from a 50-comp direct hit downstream.
    computeHobbyIqFmv.mockResolvedValue(fmvResult("cross-setkey", 40, 45));
    const res = await priceIt();

    expect(res!.valuationStatus).toBe("observed");
    expect(res!.estimateConfidence).not.toBeNull();
  });

  it("carries confidence AND a band on the estimate path", async () => {
    computeHobbyIqFmv.mockResolvedValue(fmvResult("cross-setkey", 1, 100));
    const res = await priceIt();

    expect(res!.estimateConfidence).not.toBeNull();
    expect(res!.estimateLow).toBeGreaterThan(0);
    expect(res!.estimateHigh).toBeGreaterThan(res!.estimateLow!);
    expect(res!.estimateLow).toBeLessThan(100);
    expect(res!.estimateHigh).toBeGreaterThan(100);
  });

  it("keeps returning null when the pool has no basis at all", async () => {
    // Unchanged: the caller falls through to the legacy estimator.
    computeHobbyIqFmv.mockResolvedValue({
      fmv: null,
      method: "no-basis",
      compCount: 0,
      confidence: 0,
      min: null,
      max: null,
      basisNote: "no comps",
    });
    expect(await priceIt()).toBeNull();
  });

  it("still treats grade-cross-raw as a synthetic estimate", async () => {
    // Unchanged behaviour — it was already correctly classified.
    computeHobbyIqFmv.mockResolvedValue(fmvResult("grade-cross-raw", 25, 80));
    const res = await priceIt();
    expect(res!.valuationStatus).toBe("estimated");
    expect(res!.fairMarketValue).toBeNull();
  });
});
