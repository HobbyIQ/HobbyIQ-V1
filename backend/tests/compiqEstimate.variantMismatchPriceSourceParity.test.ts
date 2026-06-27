/**
 * CF-VARIANT-MISMATCH-PRICESOURCE-PARITY (2026-05-28) — propagate the
 * router's parallel-resolution attribution onto the variant-mismatch
 * response so iOS / sweeps / backtests can distinguish variant-mismatch
 * failures from other no-FMV outcomes.
 *
 * Background: the variant-mismatch return at compiqEstimate.service.ts
 * line ~1860-1892 fires when the variant-tier-ladder rejects all of the
 * comps from the router (T0→T3 exhausted, everythingFilteredOut). Pre-
 * fix it omitted the four priceSource fields that the successful pricing
 * path surfaces (priceSource, priceSourceInternal,
 * parallelMatchFilteredCount, parallelMatchUnifiedCount). Post-fix it
 * propagates whatever the router determined.
 *
 * Why propagate instead of synthesizing: priceSource describes HOW the
 * comp pool was CONSTRUCTED by the router (parallel-id / title-matched /
 * unified). That attribution remains accurate when the variant filter
 * rejects the pool downstream — variant rejection is a different axis,
 * already communicated via `source: "variant-mismatch"` + variantWarning.
 *
 * Coverage:
 *  - Positive: variant-mismatch return INCLUDES all four priceSource
 *    fields with values propagated from the router.
 *  - Positive: works with parallel input ("approximate" / title-matched
 *    pool) and without parallel ("broad" / unified-no-parallel).
 *  - Negative scope-lock regression: the OTHER three non-success paths
 *    (no-recent-comps, sibling-pool, unsupported_sport) STILL do NOT
 *    surface priceSource fields. Pins this CF's scope behaviorally and
 *    catches drift if someone later mistakenly adds the fields there
 *    without doing the design calls captured in CF-PRICESOURCE-PARITY-
 *    FULL (sibling-pool synthesis ambiguity, unsupported-sport
 *    applicability).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock findCompsRouted so we can shape the router response to trigger
// each non-success return path inside computeEstimate. Same pattern as
// compiqEstimateQueryContext.test.ts.
// CF-CARDSIGHT-REMOVAL (Wave 3): stub the trendIQ L3 forward-projection seam so
// computeEstimate doesn't make an un-mocked ~5s live fetchCompsByPlayer HTTP call
// and exceed the 5000ms vitest timeout. Empty comps keeps trendIQ "insufficient"
// (identical to the live fallback), leaving all assertions unaffected.
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn(
      async (input: { playerName: string; product: string; cardYear?: number }) => ({
        player: input.playerName,
        product: input.product,
        ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
        cardIds: [],
        comps: [],
        cached: false,
        warnings: [],
      }),
    ),
  };
});

vi.mock("../src/services/compiq/cardsight.router.js", () => ({
  findCompsRouted: vi.fn(),
  searchCardsRouted: vi.fn().mockResolvedValue([]),
  getCardSalesRouted: vi.fn().mockResolvedValue([]),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as router from "../src/services/compiq/cardsight.router.js";

const mockFindCompsRouted = router.findCompsRouted as unknown as ReturnType<typeof vi.fn>;

/**
 * Build a router response that triggers variant-mismatch: card resolves
 * to a Bonemer-shaped record but every sale title is plain (no "Gold"
 * token), so when the user asks for parallel="Gold" the tier-ladder T0-T3
 * will reject all of them.
 */
function variantMismatchRouterResponse(over: {
  priceSource?: "exact" | "approximate" | "broad";
  priceSourceInternal?: string;
  parallelMatchFilteredCount?: number;
  parallelMatchUnifiedCount?: number;
} = {}) {
  const now = Date.now();
  const sales = Array.from({ length: 5 }, (_, i) => ({
    price: 100 + i * 10,
    date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
    grade: "PSA 9",
    source: "card_hedge",
    sale_type: "auction",
    // No "Gold" anywhere — variant filter must reject for parallel="Gold".
    title: "2024 Bowman Chrome Caleb Bonemer Auto",
    url: null,
  }));
  return {
    card: {
      card_id: "bonemer-card-id",
      title: "2024 Bowman Chrome Caleb Bonemer",
      player: "Caleb Bonemer",
      set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: sales titles + auto narrative → CPA subset (watch: confirm variant-mismatch still BITES post-rewrite)
      year: 2024,
      number: null,
      variant: null,
    },
    sales,
    variantWarning: [],
    aiCategory: "Baseball",
    priceSource: over.priceSource ?? "broad",
    priceSourceInternal: over.priceSourceInternal ?? "unified-no-parallel",
    parallelMatchFilteredCount: over.parallelMatchFilteredCount ?? 5,
    parallelMatchUnifiedCount: over.parallelMatchUnifiedCount ?? 5,
  };
}

/** Build a router response with ZERO sales — triggers no-recent-comps. */
function noRecentCompsRouterResponse() {
  return {
    card: {
      card_id: "test-card-id",
      title: "Test Card",
      player: "Test Player",
      set: "Test Set",
      year: 2024,
      number: null,
      variant: null,
    },
    sales: [],
    variantWarning: [],
    aiCategory: "Baseball",
    priceSource: "broad" as const,
    priceSourceInternal: "unified-no-parallel",
    parallelMatchFilteredCount: 0,
    parallelMatchUnifiedCount: 0,
  };
}

/** Build a router response that triggers unsupported_sport short-circuit. */
function unsupportedSportRouterResponse() {
  return {
    card: {
      card_id: "jordan-card",
      title: "1986 Fleer Michael Jordan",
      player: "Michael Jordan",
      set: "Fleer",
      year: 1986,
      number: null,
      variant: null,
    },
    sales: [
      {
        price: 1000,
        date: new Date().toISOString(),
        grade: "PSA 8",
        source: "card_hedge",
        sale_type: "auction",
        title: "1986 Fleer Michael Jordan PSA 8",
        url: null,
      },
    ],
    variantWarning: [],
    aiCategory: "Basketball",
    priceSource: "broad" as const,
    priceSourceInternal: "unified-no-parallel",
    parallelMatchFilteredCount: 1,
    parallelMatchUnifiedCount: 1,
  };
}

describe("CF-VARIANT-MISMATCH-PRICESOURCE-PARITY — variant-mismatch propagates priceSource fields", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("variant-mismatch return INCLUDES priceSource fields (the core fix)", async () => {
    mockFindCompsRouted.mockResolvedValue(variantMismatchRouterResponse({
      priceSource: "broad",
      priceSourceInternal: "unified-no-parallel",
      parallelMatchFilteredCount: 5,
      parallelMatchUnifiedCount: 5,
    }));

    const result = (await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Gold",  // none of the returned sales have "Gold" → variant mismatch
      gradeCompany: "PSA",
      gradeValue: 9,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("variant-mismatch");
    // All four priceSource fields present on the response.
    expect(result.priceSource).toBe("broad");
    expect(result.priceSourceInternal).toBe("unified-no-parallel");
    expect(result.parallelMatchFilteredCount).toBe(5);
    expect(result.parallelMatchUnifiedCount).toBe(5);
  });

  it("title-match-low-sample BYPASSES the variant tier ladder (CF-PINNED-PARALLEL-RECOVERY #3)", async () => {
    // CF-PINNED-PARALLEL-RECOVERY (2026-06-11) #3: when the router (or
    // pinned-id branch's recovery) reports title-matched-parallel or
    // title-match-low-sample, the value-path BYPASSES the variant tier
    // ladder. Rationale: title-match already did the variant-correctness
    // check (word-boundary + sibling-registry guard + span-scoped
    // finish-vocab backstop) that the ladder duplicates; double-rejecting
    // collapses clean 1-2-comp recovery pools to "variant-mismatch" with
    // no FMV. Post-bypass, the pool flows through to FMV computation
    // with priceSource attribution preserved for the thin-data disclosure.
    //
    // Pre-CF: this case returned source="variant-mismatch" because the
    // 2-comp pool was below VARIANT_TIER_MIN_COMPS=3. Post-CF: the ladder
    // is skipped for recovery sources; source becomes "live" (FMV
    // present) or "no-recent-comps" (pool too thin for an anchor).
    // Either way, NOT variant-mismatch.
    mockFindCompsRouted.mockResolvedValue(variantMismatchRouterResponse({
      priceSource: "approximate",
      priceSourceInternal: "title-match-low-sample",
      parallelMatchFilteredCount: 2,
      parallelMatchUnifiedCount: 25,
    }));

    const result = (await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Gold",
      gradeCompany: "PSA",
      gradeValue: 9,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).not.toBe("variant-mismatch");
    // priceSource attribution still propagates on whichever path was taken.
    expect(result.priceSource).toBe("approximate");
    expect(result.priceSourceInternal).toBe("title-match-low-sample");
    expect(result.parallelMatchFilteredCount).toBe(2);
    expect(result.parallelMatchUnifiedCount).toBe(25);
  });

  it("variant-mismatch propagates 'exact' attribution when router reports a parallel-id match (pool was correctly scoped, variant filter still rejected)", async () => {
    mockFindCompsRouted.mockResolvedValue(variantMismatchRouterResponse({
      priceSource: "exact",
      priceSourceInternal: "cardsight-parallel-id",
      parallelMatchFilteredCount: 5,
      parallelMatchUnifiedCount: 5,
    }));

    const result = (await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Gold",
      gradeCompany: "PSA",
      gradeValue: 9,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("variant-mismatch");
    expect(result.priceSource).toBe("exact");
    expect(result.priceSourceInternal).toBe("cardsight-parallel-id");
  });

  it("variant-mismatch preserves null when router returned no attribution (defensive)", async () => {
    // Router response with priceSource fields undefined → response surfaces
    // them as null (the same default the successful path uses at line ~2796).
    const r = variantMismatchRouterResponse();
    delete (r as any).priceSource;
    delete (r as any).priceSourceInternal;
    delete (r as any).parallelMatchFilteredCount;
    delete (r as any).parallelMatchUnifiedCount;
    mockFindCompsRouted.mockResolvedValue(r);

    const result = (await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Gold",
      gradeCompany: "PSA",
      gradeValue: 9,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("variant-mismatch");
    expect(result.priceSource).toBeNull();
    expect(result.priceSourceInternal).toBeNull();
    expect(result.parallelMatchFilteredCount).toBeNull();
    expect(result.parallelMatchUnifiedCount).toBeNull();
  });
});

describe("CF-VARIANT-MISMATCH-PRICESOURCE-PARITY — scope-lock regression (other paths still omit priceSource fields)", () => {
  // These tests pin the scope of THIS CF behaviorally. If someone later
  // adds priceSource fields to sibling-pool / unsupported_sport without
  // doing the design calls captured in CF-PRICESOURCE-PARITY-FULL, these
  // will catch the drift. The sibling-pool / unsupported_sport cases
  // have design ambiguity (sibling-pool: synthesized from peer cards;
  // unsupported_sport: does priceSource apply when sport-rejected?) that
  // require explicit resolution — not silent expansion.
  //
  // NOTE: no-recent-comps was originally scope-locked too, but
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-10) extended it INTENTIONALLY.
  // Rationale: the pinned-id branch's title-match recovery emits
  // priceSourceInternal="unified-fallback-no-match" when it couldn't
  // isolate the parallel from the unified pool — and collapses comps
  // to 0 to keep base-pooled FMVs out of the training corpus. That
  // routes through no-recent-comps. iOS needs to see the
  // "unified-fallback-no-match" attribution to render the right "we
  // couldn't isolate this parallel" copy rather than a generic
  // "couldn't find recent comps" message. The no-recent-comps positive
  // test for that propagation lives in compiqPinnedParallelRecovery.test.ts.

  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-recent-comps return propagates priceSource (CF-PINNED-PARALLEL-RECOVERY extension)", async () => {
    mockFindCompsRouted.mockResolvedValue(noRecentCompsRouterResponse());

    const result = (await computeEstimate({
      playerName: "Test Player",
      cardYear: 2024,
      product: "Test Set",
      gradeCompany: "PSA",
      gradeValue: 9,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("no-recent-comps");
    // priceSource fields now propagate (was scope-locked-undefined pre-
    // CF-PINNED-PARALLEL-RECOVERY 2026-06-10). The pinned-id branch's
    // title-match recovery surfaces "unified-fallback-no-match" through
    // this return path; iOS reads it to render the right UX.
    expect(result.priceSource).toBe("broad");
    expect(result.priceSourceInternal).toBe("unified-no-parallel");
    expect(result.parallelMatchFilteredCount).toBe(0);
    expect(result.parallelMatchUnifiedCount).toBe(0);
  });

  it("unsupported_sport return does NOT surface priceSource fields (out of scope for this CF)", async () => {
    mockFindCompsRouted.mockResolvedValue(unsupportedSportRouterResponse());

    const result = (await computeEstimate({
      playerName: "Michael Jordan",
      cardYear: 1986,
      product: "Fleer",
      gradeCompany: "PSA",
      gradeValue: 8,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("unsupported_sport");
    expect(result.priceSource).toBeUndefined();
    expect(result.priceSourceInternal).toBeUndefined();
    expect(result.parallelMatchFilteredCount).toBeUndefined();
    expect(result.parallelMatchUnifiedCount).toBeUndefined();
  });

  // sibling-pool intentionally not covered here: its trigger requires
  // both a target-card empty result AND a successful sibling-pool fetch
  // via fetchSiblingSales (separate code path that requires its own
  // mock surface). Its scope-lock case is captured by code review
  // discipline + CF-PRICESOURCE-PARITY-FULL design call rather than by
  // a unit test in this CF.
});
