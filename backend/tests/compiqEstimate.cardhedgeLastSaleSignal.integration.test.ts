/**
 * CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX (2026-06-26) — THE MISSING TEST CLASS.
 *
 * Across the 8-CF cardhedge-last-sale arc, every CF's unit tests passed and
 * every CF's first prod reprice surfaced a NEW gap. The pattern: the helper's
 * unit test mocks input shape X (e.g. "Blue X-Fractor /150"); the engine
 * call site passes shape Y (e.g. "blue x fractor 150"); the helper handles
 * X cleanly but receives Y in prod and silently returns null.
 *
 * This file pins what the helper unit tests cannot: that the ENGINE CALL
 * SITE passes the helper a parallel string the helper can actually handle.
 * Run the engine end-to-end with the exact prod reprice shape; assert
 * modelExpectation and modelSignal populate on the response.
 *
 * The shape is the live 2026-06-26 20:23Z Hartman BXF /150 reprice that
 * surfaced the bug:
 *   - body.parallel = "Blue X-Fractor /150" (the raw user-facing form)
 *   - CH returns 1 trusted sale at $450, 7 days old
 *   - Cardsight pricing has ~20 base-auto records around $80-90
 *   - getCardDetail.setName = "Chrome Prospects Autographs" (plural)
 *   - product = "Bowman" (the holding's product field)
 *   - subjectSubset resolves to "Chrome Prospect Autographs" (singular)
 *   - curated row found: multiplier 2.974×, range [2.214, 3.795]
 *   - Build B fires off-sample (base ~$85 > sampleBaseRange[1]=56.5)
 *
 * Pre-fix: call site passed normalizedParallel ("blue x fractor 150") →
 * helper's print-run strip didn't fire → table lookup missed → result null.
 * Post-fix: call site passes body.parallel ("Blue X-Fractor /150") → strip
 * fires → "Blue X-Fractor" → table lookup hits → signal populates.
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

vi.mock("../src/services/compiq/cardsight.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.client.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
  };
});

import { getCardSalesRoutedWithProvenance } from "../src/services/compiq/cardsight.router.js";
import { getPricing, getCardDetail } from "../src/services/compiq/cardsight.client.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockGetCardSalesRoutedWithProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const BXF_150_PARALLEL_ID = "b83de312-609d-4d58-af41-c8766a81835f";
const BXF_150_CH_ID = "1778542140951x283396404010038530";

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

function buildHartmanDetail() {
  return {
    notFound: false,
    id: HARTMAN_CS_ID,
    name: "Eric Hartman",
    number: "CPA-EHA",
    releaseName: "Bowman",
    setName: "Chrome Prospects Autographs", // plural — the real prod shape
    year: 2026,
    parallels: [{ id: BXF_150_PARALLEL_ID, name: "Blue X-Fractor", numberedTo: 150 }],
    attributes: [],
  } as any;
}

function buildHartmanBaseAutoPricing(baseAutoCount: number, basePrice: number) {
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
        price: basePrice + (i % 8),
        date: daysAgo(5 + (i % 30)),
        title: "Eric Hartman 2026 Bowman Chrome CPA-EHA Auto",
        parallel_id: null,
      })),
    },
    graded: [],
    meta: { total_records: baseAutoCount, last_sale_date: daysAgo(0) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// THE PROD CASE — engine end-to-end with the exact 2026-06-26 20:23Z shape
// ============================================================================

describe("computeEstimate end-to-end → modelExpectation + modelSignal populate on Hartman BXF /150 (CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX)", () => {
  it("THE PROD CASE: body.parallel='Blue X-Fractor /150' (raw, with slash) → engine helper fires → modelExpectation populated, modelSignal.lean='sell'", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)], // ← 7 days old (the prod shape)
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    mockGetPricing.mockResolvedValue(buildHartmanBaseAutoPricing(20, 82));

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman", // ← the holding's actual product field
      parallel: "Blue X-Fractor /150", // ← THE RAW FORM (the contract)
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    } as any)) as Record<string, unknown>;

    // ════════════════════════════════════════════════════════════════════
    // The PRIMARY assertion — the bug this CF closes:
    // modelExpectation and modelSignal are POPULATED on the response.
    // Pre-fix this was undefined (helper returned null); post-fix it's
    // the expected shape.
    // ════════════════════════════════════════════════════════════════════
    expect(result.estimateSource).toBe("cardhedge-last-sale");
    expect(result.fairMarketValue).toBeNull();

    const modelExpectation = result.modelExpectation as any;
    expect(modelExpectation).toBeDefined();
    expect(modelExpectation).not.toBeNull();

    // The exact Hartman BXF /150 row: multiplier 2.974, range [2.214, 3.795], n=9.
    expect(modelExpectation.multiplier).toBe(2.974);
    expect(modelExpectation.multiplierRange).toEqual([2.214, 3.795]);
    expect(modelExpectation.n).toBe(9);
    expect(modelExpectation.basis).toBe("base_anchored_off_sample_paired_premium");
    // Off-sample price range: ~$254-$278 centered on ~$266.
    expect(modelExpectation.value).toBeGreaterThan(255);
    expect(modelExpectation.value).toBeLessThan(280);

    const modelSignal = result.modelSignal as any;
    expect(modelSignal).toBeDefined();
    expect(modelSignal).not.toBeNull();
    expect(modelSignal.lean).toBe("sell");
    expect(modelSignal.effectiveMultiplier).toBeGreaterThan(3.795);
    expect(modelSignal.deltaPct).toBeGreaterThan(50);

    // Engine still emits the lastSale headline alongside the signal.
    const lastSale = result.lastSale as any;
    expect(lastSale).toBeDefined();
    expect(lastSale.price).toBe(450);
  });

  it("ABSENT SIGNAL FALLBACK: helper returns null (e.g. subset unresolvable) → estimateSource still cardhedge-last-sale, modelExpectation+Signal undefined/null on response", async () => {
    // Locks the FALLBACK SHAPE: when the signal can't compute, the
    // response stays cardhedge-last-sale with lastSale intact. iOS renders
    // "Last sold $X via 1 comp" with no badge. No fake signal.
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    // setName is something the normalizer doesn't know → subset null → null result.
    mockGetCardDetail.mockResolvedValue({ ...buildHartmanDetail(), setName: "Bowman Sterling" });
    mockGetPricing.mockResolvedValue(buildHartmanBaseAutoPricing(20, 82));

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    } as any)) as Record<string, unknown>;

    expect(result.estimateSource).toBe("cardhedge-last-sale");
    // Conditional spread → keys absent when null.
    expect(result.modelExpectation).toBeUndefined();
    expect(result.modelSignal).toBeUndefined();
    // lastSale still surfaces (no-signal fallback shape).
    expect((result.lastSale as any)?.price).toBe(450);
  });
});
