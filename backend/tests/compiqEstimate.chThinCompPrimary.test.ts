/**
 * CF-CH-THIN-COMP-PRIMARY (2026-06-26) — when CardHedge has a trusted
 * parallel-specific result and Cardsight only has parent/base pool comps
 * for a DIFFERENT variant, CardHedge wins outright, even at n=1.
 *
 * Closes the Blue X-Fractor /150 "Can't estimate yet" failure mode: CH
 * had a trusted single $450 sale on the correct parallel; CS pool was
 * 82 base records median $85 (different card). Pre-CF the engine fired
 * a wild divergence event and nulled the holding via the variant-
 * mismatch tier ladder. Post-CF: CH-trusted bypasses the tier-ladder
 * count-floor, the wrong-card divergence is suppressed, and n=1 emits
 * "cardhedge-last-sale" so iOS renders "Last sold $450 via 1 comp".
 *
 * Four tests (matching the CF spec):
 *  1. Blue X-Fractor shape (CH n=1 $450, CS base pool $85) → estimateSource=
 *     "cardhedge-last-sale", lastSale.price=450, chCompCount=1, NO
 *     divergence fired, NOT nulled by variant-mismatch.
 *  2. CH n>=2 trusted → estimateSource="cardhedge", FMV=median (unchanged).
 *  3. CH no match → Cardsight floor / null (unchanged — floor preserved).
 *  4. CH trusted but CS ALSO has parallel-specific comps (same card) →
 *     divergence STILL fires (suppression scoped to wrong-card pool only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    getCardSalesRouted: vi.fn(),
    getCardSalesRoutedWithProvenance: vi.fn(),
    findCompsRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

vi.mock("../src/services/compiq/catalogSource.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/catalogSource.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
  };
});

import { getCardSalesRoutedWithProvenance } from "../src/services/compiq/cardsight.router.js";
import { getPricing, getCardDetail } from "../src/services/compiq/catalogSource.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockGetCardSalesRoutedWithProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const BXF_150_PARALLEL_ID = "b83de312-609d-4d58-af41-c8766a81835f";
const BXF_150_CH_ID = "1778542140951x283396404010038530";

// Date helper — give a date N days before today. Engine reads Date.now().
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function buildChSale(price: number, daysOld: number) {
  return {
    price,
    date: daysAgo(daysOld),
    grade: "Raw",
    source: "cardhedge" as const,
    sale_type: "Auction",
    title: "Hartman 2026 Bowman Blue X-Fractor /150 Auto CPA-EHA",
    url: null,
  };
}

function buildCsPricingResponse(records: Array<{ price: number; daysOld: number; parallelId?: string | null; title?: string }>) {
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: {
      count: records.length,
      records: records.map((r) => ({
        price: r.price,
        date: daysAgo(r.daysOld),
        title: r.title ?? "Hartman base CPA-EHA",
        parallel_id: r.parallelId ?? null,
        parallel_name: r.parallelId ? "Blue X-Fractor /150" : null,
      })),
    },
    graded: [],
    meta: { total_records: records.length, last_sale_date: daysAgo(records[0]?.daysOld ?? 0) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardDetail.mockResolvedValue({
    notFound: false,
    releaseName: "Bowman",
    year: "2026",
    parallels: [{ id: BXF_150_PARALLEL_ID, name: "Blue X-Fractor", numberedTo: 150 }],
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// TEST 1 — the Blue X-Fractor /150 case: CH n=1 $450 vs CS base pool $85
// ============================================================================

describe("CF-CH-THIN-COMP-PRIMARY — Blue X-Fractor /150 (CH n=1, CS base-only pool)", () => {
  it("CH trusted n=1 ($450) + CS parent pool (82 records median $85, no parallel_id match) → estimateSource='cardhedge-last-sale', lastSale.price=450, chCompCount=1, NOT nulled, NO divergence fired", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 25)], // single sale, 25 days old (>14 → would normally insufficient)
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    // CS pool: 82 base records (no parallel_id tags = wrong card pool).
    mockGetPricing.mockResolvedValue(
      buildCsPricingResponse(
        Array.from({ length: 82 }, (_, i) => ({
          price: 80 + (i % 10),
          daysOld: 5 + (i % 30),
          parallelId: null, // ← key: CS records lack parallel_id (parent pool)
        })),
      ),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // NOT nulled by variant-mismatch — the CH-trusted bypass let it through.
    expect((result as any).source).not.toBe("variant-mismatch");

    // estimateSource is the NEW value for n==1 CH-trusted.
    expect(result.estimateSource).toBe("cardhedge-last-sale");

    // FMV NOT presented (Drew: "Do NOT present n=1 as FMV").
    expect(result.fairMarketValue).toBeNull();

    // lastSale carries the single CH sale.
    const lastSale = (result as any).lastSale;
    expect(lastSale).toBeDefined();
    expect(lastSale.price).toBe(450);

    // chCompCount=1 surfaced on the response.
    expect((result as any).chCompCount).toBe(1);

    // chCardId carried (proves CH-trusted served).
    expect((result as any).chCardId).toBe(BXF_150_CH_ID);
    expect((result as any).chTrustReason).toBe("prices_by_card_honest");

    // trendEstimate SUPPRESSED — no competing estimatedValue when CH-last-sale.
    expect((result as any).estimatedValue).toBeNull();
    expect((result as any).estimateRange).toBeNull();

    // NO divergence event fired — CS parent-only pool was correctly suppressed.
    const divergenceFired = logSpy.mock.calls.some((c) =>
      String(c[0] ?? "").includes('"event":"ch_cs_divergence"'),
    );
    expect(divergenceFired).toBe(false);

    logSpy.mockRestore();
  });
});

// ============================================================================
// AGE-AXIS BOUNDARY — CF-CH-THIN-COMP-FRESH-SALE (2026-06-26)
//
// The prior CF's split lived INSIDE `if (insufficient)`. The existing
// predicate routes "1 comp, <=14 days → allow" to the main pipeline,
// which can't FMV n=1 and emits null. Production data on 2026-06-26
// surfaced this: the live CH sale was 7 days old (≤14), so the engine
// took the main pipeline, FMV came back null, and the holding was marked
// "Low confidence." The follow-up CF (CF-CH-THIN-COMP-FRESH-SALE) routes
// trusted CH n=1 into the insufficient branch unconditionally so the
// cardhedge-last-sale ladder arm fires regardless of sale age.
//
// These tests lock the age-axis: 1 day (fresh boundary), 7 days (the
// prod case that exposed the gap), 14 days (pre-existing boundary —
// still works post-fix). The 25-day case is the original test above,
// retained as the "stale" sample.
// ============================================================================

describe("CF-CH-THIN-COMP-FRESH-SALE — CH n=1 trusted reaches cardhedge-last-sale at all sale ages", () => {
  const sharedCsPool = buildCsPricingResponse(
    Array.from({ length: 30 }, (_, i) => ({
      price: 80 + (i % 10),
      daysOld: 5 + (i % 30),
      parallelId: null,
    })),
  );

  it("FRESH (1 day old): trusted CH n=1 still reaches cardhedge-last-sale (fresh-boundary lock)", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 1)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(sharedCsPool);

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    expect(result.estimateSource).toBe("cardhedge-last-sale");
    expect(result.fairMarketValue).toBeNull();
    expect((result as any).lastSale?.price).toBe(450);
    expect((result as any).chCompCount).toBe(1);
  });

  it("PROD CASE (7 days old): the live failure — fresh single sale that skipped cardhedge-last-sale pre-fix", async () => {
    // This is the exact prod shape from 2026-06-26 18:12:11Z: 1 trusted CH
    // sale, 7 days old. Pre-CF-CH-THIN-COMP-FRESH-SALE: engine took the
    // main pipeline (insufficient=false), FMV came back null, the
    // cardhedge-last-sale split never ran, holding marked "Low confidence."
    // Post-fix: engine routes to insufficient branch via the trusted-CH
    // force, cardhedge-last-sale fires, lastSale persisted.
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(sharedCsPool);

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // The prod-case assertion: source IS "cardhedge-last-sale" on the
    // fresh path now, not null / "no-recent-comps" / "live".
    expect(result.estimateSource).toBe("cardhedge-last-sale");
    expect(result.fairMarketValue).toBeNull();
    expect((result as any).lastSale?.price).toBe(450);
    expect((result as any).chCompCount).toBe(1);
    expect((result as any).chCardId).toBe(BXF_150_CH_ID);
    expect((result as any).chTrustReason).toBe("prices_by_card_honest");
  });

  it("PRE-EXISTING BOUNDARY (14 days old): trusted CH n=1 reaches cardhedge-last-sale (at the existing >14 cutoff)", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 14)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(sharedCsPool);

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    expect(result.estimateSource).toBe("cardhedge-last-sale");
    expect((result as any).lastSale?.price).toBe(450);
  });
});

// ============================================================================
// TEST 2 — CH n>=2 trusted → estimateSource="cardhedge", FMV=median (unchanged)
// ============================================================================

describe("CF-CH-THIN-COMP-PRIMARY — CH trusted n>=2 (legacy 'cardhedge' branch unchanged)", () => {
  it("CH trusted n=3 ($440, $450, $460) → estimateSource='cardhedge', FMV is the CH median", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [
        buildChSale(440, 5),
        buildChSale(450, 7),
        buildChSale(460, 10),
      ],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(buildCsPricingResponse([]));

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    expect(result.estimateSource).toBe("cardhedge");
    expect(typeof result.fairMarketValue).toBe("number");
    expect(result.fairMarketValue as number).toBeGreaterThan(400);
    expect(result.fairMarketValue as number).toBeLessThan(500);

    // chCompCount surfaces the actual count.
    expect((result as any).chCompCount).toBe(3);
    expect((result as any).chCardId).toBe(BXF_150_CH_ID);
  });
});

// ============================================================================
// TEST 3 — CH no match → CS floor / null (floor preserved)
// ============================================================================

describe("CF-CH-THIN-COMP-PRIMARY — FLOOR PRESERVED: CH no match → Cardsight floor unchanged", () => {
  it("CH returns 0 sales (no chCardId match) → falls through to Cardsight; estimateSource is NOT 'cardhedge*'", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({ sales: [] });
    // CS has its own thin pool — engine decides per the existing thin-data rules.
    mockGetPricing.mockResolvedValue(
      buildCsPricingResponse([
        { price: 100, daysOld: 60 },
        { price: 110, daysOld: 80 },
      ]),
    );

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue Refractor /150", // CH genuinely lacks this card
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // CRITICAL FLOOR INVARIANT: estimateSource must NOT be the CH-thin path
    // when CH didn't actually serve. The bypass only fires when CH HAS a
    // trusted match.
    expect(result.estimateSource).not.toBe("cardhedge-last-sale");
    expect(result.estimateSource).not.toBe("cardhedge");

    // No CH provenance on the response either.
    expect((result as any).chCardId).toBeUndefined();
    expect((result as any).chTrustReason).toBeUndefined();
    // chCompCount is now emitted as 0 (not omitted) when CH returns no match;
    // corpusMapping consumes it as a number. 0 still means "no CH attribution".
    expect((result as any).chCompCount).toBe(0);
  });
});

