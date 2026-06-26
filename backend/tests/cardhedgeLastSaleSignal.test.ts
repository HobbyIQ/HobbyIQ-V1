/**
 * CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26) — engine signal helper.
 *
 * Tests the multiplier-model expectation + buy/sell signal computation
 * for the cardhedge-last-sale path. Mocks getCardDetail (the subset
 * source, closing Gap A) and getPricing (the base-auto pool source for
 * Build B, closing Gap B) via the helper's `clients` injection seam —
 * no module-level vi.mock needed.
 *
 * The 4 tests Drew specified:
 *   1. THE PROD CASE — Hartman BXF /150: subset resolves "Chrome
 *      Prospects Autographs" → singular "Chrome Prospect Autographs",
 *      curated row has empirical baseRelativePremium 2.974× [2.214,
 *      3.795], base autos ~$82 → modelExpectation ≈ $244 with range
 *      [$182, $311], lastSale $450 → lean "sell", effectiveMultiplier
 *      ≈5.49× (above 3.795).
 *   2. NO CURATED ROW — a parallel with no curated entry → null
 *      result; iOS sees no signal (no fake one).
 *   3. WITHIN RANGE → lean "hold" — lastSale inside [estimateLow,
 *      estimateHigh].
 *   4. SUBSET RESOLUTION (Gap A specifically) — getCardDetail returns
 *      plural "Chrome Prospects Autographs"; normalizer converts to
 *      singular "Chrome Prospect Autographs"; row lookup succeeds.
 */
import { describe, expect, it } from "vitest";
import {
  computeCardhedgeLastSaleSignal,
} from "../src/services/compiq/cardhedgeLastSaleSignal.service.js";

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

function buildHartmanDetail() {
  // Cardsight's getCardDetail returns the actual SUBSET name (plural form),
  // which the engine's normalizer converts to the singular form the
  // curated table indexes by ("Chrome Prospect Autographs").
  return {
    notFound: false,
    id: HARTMAN_CS_ID,
    name: "Eric Hartman",
    number: "CPA-EHA",
    releaseName: "Bowman",
    setName: "Chrome Prospects Autographs",  // ← plural, the real prod shape
    year: 2026,
    parallels: [],
    attributes: [],
  } as any;
}

function buildHartmanBaseAutoPricing(baseAutoCount: number, basePrice: number) {
  // Build a CS pricing response with N base-auto sales at clustering around
  // `basePrice`. Build B's isBaseAutoTitle filter looks for "auto" tokens
  // without parallel/refractor decoration.
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: {
      count: baseAutoCount,
      records: Array.from({ length: baseAutoCount }, (_, i) => ({
        price: basePrice + (i % 8),  // small clustering around base price
        date: "2026-06-20",
        title: "Eric Hartman 2026 Bowman Chrome CPA-EHA Auto",  // BASE AUTO title (no parallel decoration)
        parallel_id: null,
      })),
    },
    graded: [],
    meta: { total_records: baseAutoCount, last_sale_date: "2026-06-20" },
  } as any;
}

// ============================================================================
// TEST 1 — Hartman BXF /150: the prod case. lean="sell".
// ============================================================================

describe("computeCardhedgeLastSaleSignal — Hartman Blue X-Fractor /150 (prod case)", () => {
  it("subset 'Chrome Prospects Autographs' (plural) → resolves → BXF /150 row found → modelExpectation ≈ $244, signal lean='sell' at $450", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");

    // Hartman's actual base-auto median (~$85) is ABOVE the row's
    // sampleBaseRange[1]=56.5, so Build B fires its OFF-SAMPLE branch
    // (CF-BUILD-B §3/§4 logic). With topBaseBucketRatio=3.254 present,
    // the band becomes [min(value, anchor), max(value, anchor)] × base:
    //   lowRatio  = min(2.974, 3.254) = 2.974
    //   highRatio = max(2.974, 3.254) = 3.254
    //   estimateLow  ≈ 85.5 × 2.974 ≈ $254
    //   estimateHigh ≈ 85.5 × 3.254 ≈ $278
    //   estimatedValue = (estimateLow + estimateHigh) / 2 ≈ $266
    expect(result.modelExpectation.multiplier).toBe(2.974);
    expect(result.modelExpectation.multiplierRange).toEqual([2.214, 3.795]);
    expect(result.modelExpectation.value).toBeGreaterThan(255);
    expect(result.modelExpectation.value).toBeLessThan(280);
    expect(result.modelExpectation.range[0]).toBeGreaterThan(240);
    expect(result.modelExpectation.range[0]).toBeLessThan(260);
    expect(result.modelExpectation.range[1]).toBeGreaterThan(265);
    expect(result.modelExpectation.range[1]).toBeLessThan(290);
    expect(result.modelExpectation.n).toBe(9);
    expect(result.modelExpectation.baseAutoCount).toBeGreaterThanOrEqual(20);
    expect(result.modelExpectation.basis).toBe("base_anchored_off_sample_paired_premium");

    // SIGNAL: $450 sale vs ~$266 expectation → strong sell.
    // effectiveMultiplier ≈ 450 / 85.5 ≈ 5.26× — way above range.high.
    expect(result.modelSignal.lean).toBe("sell");
    expect(result.modelSignal.effectiveMultiplier).toBeGreaterThan(3.795);
    expect(result.modelSignal.deltaPct).toBeGreaterThan(50); // sale is >50% above expectation
    expect(result.modelSignal.expectation).toBe(result.modelExpectation.value);
  });
});

// ============================================================================
// TEST 2 — No curated row → null (no fake signal).
// ============================================================================

describe("computeCardhedgeLastSaleSignal — NO CURATED ROW: null signal (no fake)", () => {
  it("nonsense parallel name with no curated entry → null result", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Polka Dot Hologram /1337", // NOT in the curated table
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    // Helper returns null — caller will NOT surface modelExpectation/Signal.
    expect(result).toBeNull();
  });

  it("subset can't be normalized → null (subset gate)", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        // setName is unknown to the normalizer ("Bowman Sterling" is in the
        // commented "long tail" of the normalizer — returns null by design).
        getCardDetail: async () => ({ ...buildHartmanDetail(), setName: "Bowman Sterling" }),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    expect(result).toBeNull();
  });

  it("getCardDetail throws → null (no crash, no signal)", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => {
          throw new Error("network timeout");
        },
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    expect(result).toBeNull();
  });
});

// ============================================================================
// TEST 3 — Within range → lean "hold".
// ============================================================================

describe("computeCardhedgeLastSaleSignal — WITHIN RANGE → 'hold'", () => {
  it("lastSale price inside off-sample [estimateLow, estimateHigh] band → lean='hold'", async () => {
    // Same off-sample math as Hartman: base ~$85.5, band ~[$254, $278].
    // A $270 sale is within the band → "hold".
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 270,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");

    expect(result.modelSignal.lean).toBe("hold");
    // Effective multiplier within the off-sample band's effective ratio range.
    expect(result.modelSignal.effectiveMultiplier).toBeGreaterThanOrEqual(
      result.modelExpectation.range[0] / result.modelExpectation.baseAutoMedian,
    );
    expect(result.modelSignal.effectiveMultiplier).toBeLessThanOrEqual(
      result.modelExpectation.range[1] / result.modelExpectation.baseAutoMedian,
    );
  });

  it("lastSale below estimateLow → lean='buy'", async () => {
    // A $200 sale, below the ~$254 off-sample low → "buy".
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 200,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");

    expect(result.modelSignal.lean).toBe("buy");
    expect(result.modelSignal.deltaPct).toBeLessThan(0); // sale below expectation
  });
});

// ============================================================================
// TEST 4 — Subset resolution (Gap A specifically): plural→singular normalize.
// ============================================================================

describe("computeCardhedgeLastSaleSignal — Gap A: subset resolution (plural→singular)", () => {
  it("Cardsight returns plural 'Chrome Prospects Autographs' → engine normalizer converts to singular 'Chrome Prospect Autographs' → row lookup succeeds", async () => {
    // The KEY test for Gap A: Cardsight uses plural; the curated table
    // is keyed by singular. The cardsightSubsetNormalizer DIRECT_MAP
    // explicitly translates "chrome prospects autographs" →
    // "Chrome Prospect Autographs". This test proves that translation
    // makes the curated row reachable for the Hartman shape.
    //
    // Previously the engine read fetched.card.set = ctx.product = "Bowman",
    // which couldn't normalize, so mechanism1/Build B got subset=null and
    // returned NULL_MECHANISM1_RESULT — predictedPrice null. The fix
    // routes through getCardDetail.setName instead.
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        // Plural form — the actual production shape Cardsight returns.
        getCardDetail: async () => ({
          ...buildHartmanDetail(),
          setName: "Chrome Prospects Autographs",
        }),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );

    // If the plural→singular normalization were broken, this would be null.
    // It's NOT null — the row lookup succeeded and Build B fired.
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");

    // Verify we hit the Hartman BXF /150 row specifically:
    expect(result.modelExpectation.multiplier).toBe(2.974);
    expect(result.modelExpectation.n).toBe(9);
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe("computeCardhedgeLastSaleSignal — edge cases", () => {
  it("empty cardsightCardId → null (input gate)", async () => {
    const result = await computeCardhedgeLastSaleSignal({
      cardsightCardId: "",
      lastSalePrice: 450,
      product: "Bowman",
      parallelName: "Blue X-Fractor /150",
      year: 2026,
    });
    expect(result).toBeNull();
  });

  it("non-positive lastSale price → null (input gate)", async () => {
    const result = await computeCardhedgeLastSaleSignal({
      cardsightCardId: HARTMAN_CS_ID,
      lastSalePrice: 0,
      product: "Bowman",
      parallelName: "Blue X-Fractor /150",
      year: 2026,
    });
    expect(result).toBeNull();
  });

  it("empty base-auto pool → null (insufficient comps)", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () =>
          buildHartmanBaseAutoPricing(0, 82), // empty pool
      },
    );
    expect(result).toBeNull();
  });
});

// ============================================================================
// CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX (2026-06-26) — both-input-shape
// contract tests. The helper's design contract is "take the raw user-facing
// parallel string with print-run suffix (e.g. 'Blue X-Fractor /150')". Live
// 2026-06-26 20:23Z reprice surfaced that the engine call site was passing
// the engine-normalized form ('blue x fractor 150'), so the strip didn't
// fire and lookup missed. The CF moves the call site to pass the raw form
// AND pins the contract from both sides here.
// ============================================================================

describe("computeCardhedgeLastSaleSignal — parallel input contract (CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX)", () => {
  it("RAW form 'Blue X-Fractor /150' (the contract) → SUCCESS (lookup matches)", async () => {
    // Identical to test 1's prod-case shape — re-asserted as the contract
    // anchor. If this test breaks, the helper's strip is broken; if test
    // below breaks, the helper accidentally started handling the normalized
    // form too (drift away from the contract).
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150", // ← raw, with slash
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.multiplier).toBe(2.974);
    expect(result.modelSignal.lean).toBe("sell");
  });

  it("NORMALIZED form 'blue x fractor 150' (NOT the contract) → null (helper does NOT handle the post-normalize form by design)", async () => {
    // This is the EXACT input shape the engine call site was passing pre-
    // CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX. The helper returns null because
    // its strip regex requires the slash. The fix is at the call site (pass
    // raw); the helper deliberately does NOT add a post-normalize strip
    // because no safe regex exists for "trailing digits that are a print
    // run vs digits that are part of the parallel name". The integration
    // test (engineCallSite-shape) is what proves the call site passes raw.
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "blue x fractor 150", // ← normalized, slash-stripped
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );
    expect(result).toBeNull();
  });

  it("CASING — 'blue x-fractor /150' (lowercased + dash preserved) → SUCCESS (lookup is case-insensitive on this path)", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "blue x-fractor /150",
        year: 2026,
      },
      {
        getCardDetail: async () => buildHartmanDetail(),
        getPricing: async () => buildHartmanBaseAutoPricing(20, 82),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.multiplier).toBe(2.974);
  });
});
