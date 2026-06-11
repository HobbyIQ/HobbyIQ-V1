// CF-PINNED-PARALLEL-RECOVERY (2026-06-10): regression coverage for the
// pinned-id branch's new title-match recovery path.
//
// Bug being closed: when the iOS client sent {cardsightCardId, parallelId},
// the pinned branch in fetchComps called filterRecordsByParallel against
// the unified Cardsight pool. Cardsight's per-sale parallel_id tagging is
// unreliable (documented at cardsight.client.ts:513-522 from the
// 2026-05-27 Maddux Tiffany incident; reconfirmed 2026-06-10 for 2024
// Bowman Chrome Blue Refractor /150), so the filter collapsed to 0 even
// when the unified pool contained real parallel-titled sales.
//
// Recovery shape mirrors the routed-search path's applyParallelTitleMatch
// wiring: when filteredByParallel.length < 3 AND parallelId is provided
// AND the unified pool has >= 3 records, fall back to title-token matching
// with a specificity guard built from getCardDetail-fetched parallels[].
//
// Hard guardrails this file pins:
//   1. "unified-fallback-no-match" must NOT emit a base-pooled FMV
//      tagged to the parallel — it'd poison the training corpus. We
//      collapse to thin-data (0 comps emitted) so the downstream short-
//      circuit hits emitPredictionToCorpus with fairMarketValue=null.
//   2. getCardDetail must NEVER fire on base requests (parallelId=null)
//      or when filteredByParallel already cleared the threshold.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";

const LEO_BASE_ID = "11111111-1111-1111-1111-111111111111";
const BLUE_REFRACTOR_150_ID = "22222222-2222-2222-2222-222222222222";
const GOLD_50_ID = "33333333-3333-3333-3333-333333333333";

const today = new Date();
const isoDaysAgo = (n: number) =>
  new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// Realistic pricing fixture: 5 base records, 5 Blue Refractor /150 records,
// 3 Gold /50 records — NONE tagged with parallel_id (the documented
// Cardsight behavior we're recovering from). Titles let title-match
// reliably isolate the Blue subset.
function makeLeoUnifiedPricing() {
  const records: Array<Record<string, unknown>> = [];
  // Base
  for (let i = 0; i < 5; i++) {
    records.push({
      title: `2024 Bowman Chrome Prospects Leo De Vries CPA-LDV (base ${i})`,
      price: 80 + i * 5,
      date: isoDaysAgo(i),
      source: "ebay",
      url: null,
      parallel_id: null,
    });
  }
  // Blue Refractor /150 — real sales sitting in the unified pool
  for (let i = 0; i < 5; i++) {
    records.push({
      title: `2024 Bowman Chrome Prospects Leo De Vries Blue Refractor /150 CPA-LDV (blue ${i})`,
      price: 320 + i * 15,
      date: isoDaysAgo(i + 1),
      source: "ebay",
      url: null,
      parallel_id: null,
    });
  }
  // Gold /50 — the sibling that the specificity guard must exclude when
  // the user asked for "Blue" (avoids Gold-Blue overlap pull).
  for (let i = 0; i < 3; i++) {
    records.push({
      title: `2024 Bowman Chrome Prospects Leo De Vries Gold Refractor /50 CPA-LDV (gold ${i})`,
      price: 1200 + i * 50,
      date: isoDaysAgo(i + 2),
      source: "ebay",
      url: null,
      parallel_id: null,
    });
  }
  return {
    card: {
      card_id: LEO_BASE_ID,
      name: "Leo De Vries",
      number: "CPA-LDV",
      set: {
        set_id: "set-2024-bowman-chrome",
        name: "Chrome Prospect Autographs",
        year: "2024",
        release: "Bowman Chrome",
      },
    },
    raw: { count: records.length, records },
    graded: [],
    meta: { total_records: records.length, last_sale_date: isoDaysAgo(0) },
  } as any;
}

function makeLeoDetail() {
  return {
    id: LEO_BASE_ID,
    name: "Leo De Vries",
    number: "CPA-LDV",
    releaseName: "Bowman Chrome",
    setName: "Chrome Prospect Autographs",
    year: 2024,
    parallels: [
      { id: BLUE_REFRACTOR_150_ID, name: "Blue Refractor" },
      { id: GOLD_50_ID, name: "Gold Refractor" },
    ],
    attributes: [],
  } as any;
}

// ───────────────────────────────────────────────────────────────────────────

describe("CF-PINNED-PARALLEL-RECOVERY — Leo De Vries Blue Refractor /150", () => {
  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers Blue-titled records via title-match when Cardsight didn't tag parallel_id", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLeoUnifiedPricing(),
    );
    (cardSight.getCardDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLeoDetail(),
    );

    const result = (await computeEstimate(
      {
        playerName: LEO_BASE_ID,
        cardsightCardId: LEO_BASE_ID,
        parallelId: BLUE_REFRACTOR_150_ID,
        parallel: "Blue Refractor",
        isAuto: true,
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect((cardSight.getCardDetail as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(LEO_BASE_ID);
    expect(result.priceSourceInternal).toBe("title-matched-parallel");
    expect(result.priceSource).toBe("exact");
    expect(result.compsUsed).toBeGreaterThanOrEqual(3);

    const recentComps = result.recentComps as Array<Record<string, unknown>>;
    expect(Array.isArray(recentComps)).toBe(true);
    expect(recentComps.length).toBeGreaterThan(0);

    // Every surfaced recentComp must carry the Blue token — base and Gold
    // sales must NOT appear in the recovered pool.
    for (const c of recentComps) {
      const title = String(c.title ?? "").toLowerCase();
      expect(title).toContain("blue");
      expect(title).not.toContain("gold");
    }

    // FMV should be in the Blue-Refractor price band (~$320-$380), not
    // the base band (~$80-$100) or the Gold band ($1200+). Verifies the
    // recovery isolated the right sub-market.
    const fmv = result.fairMarketValue as number;
    expect(typeof fmv).toBe("number");
    expect(fmv).toBeGreaterThanOrEqual(200);
    expect(fmv).toBeLessThanOrEqual(500);
  });

  it("guardrail — no-match collapses to thin-data so corpus never sees a base-pooled FMV tagged to the parallel", async () => {
    // Pricing pool with ONLY base records + Gold records — no Blue
    // Refractor in the title pool. Title-match should find nothing →
    // "unified-fallback-no-match" → 0 comps in the recovered shape.
    const noBluePricing = makeLeoUnifiedPricing();
    noBluePricing.raw.records = noBluePricing.raw.records.filter(
      (r: any) => !String(r.title).toLowerCase().includes("blue"),
    );
    noBluePricing.raw.count = noBluePricing.raw.records.length;

    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(noBluePricing);
    (cardSight.getCardDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLeoDetail(),
    );

    const result = (await computeEstimate(
      {
        playerName: LEO_BASE_ID,
        cardsightCardId: LEO_BASE_ID,
        parallelId: BLUE_REFRACTOR_150_ID,
        parallel: "Blue Refractor",
        isAuto: true,
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // priceSource surfaces "broad" / "unified-fallback-no-match" — iOS
    // sees the honest "couldn't isolate the parallel" state.
    expect(result.priceSourceInternal).toBe("unified-fallback-no-match");

    // Hard corpus guard — fairMarketValue must be null so the
    // emitPredictionToCorpus call doesn't bake a base-pooled value
    // into training as a Blue /150 outcome. (Structural exclusion via
    // fmv=null mirrors CF-TREND-EXTRAPOLATED.)
    expect(result.fairMarketValue).toBeNull();
  });

  it("base (no parallelId) does not fetch getCardDetail and surfaces no priceSource fields", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLeoUnifiedPricing(),
    );
    const detailMock = cardSight.getCardDetail as unknown as ReturnType<typeof vi.fn>;
    detailMock.mockResolvedValue(makeLeoDetail());

    const result = (await computeEstimate(
      {
        playerName: LEO_BASE_ID,
        cardsightCardId: LEO_BASE_ID,
        // no parallelId, no parallel name
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(detailMock).not.toHaveBeenCalled();
    // priceSource is undefined / null on base requests (the field
    // describes parallel-match outcome and has no meaning on base).
    expect(result.priceSourceInternal ?? null).toBeNull();
    // Base request still prices normally from the parallel_id=null
    // subset of the unified pool (the 5 "base" records).
    expect(result.compsUsed).toBeGreaterThan(0);
  });

  it("getCardDetail is skipped when Cardsight tagged enough records (filter delivered)", async () => {
    // Tag the Blue records with parallel_id so filterRecordsByParallel
    // delivers them at full strength — recovery should not fire.
    const taggedPricing = makeLeoUnifiedPricing();
    taggedPricing.raw.records = (taggedPricing.raw.records as any[]).map((r) =>
      String(r.title).toLowerCase().includes("blue")
        ? { ...r, parallel_id: BLUE_REFRACTOR_150_ID }
        : r,
    );

    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(taggedPricing);
    const detailMock = cardSight.getCardDetail as unknown as ReturnType<typeof vi.fn>;
    detailMock.mockResolvedValue(makeLeoDetail());

    const result = (await computeEstimate(
      {
        playerName: LEO_BASE_ID,
        cardsightCardId: LEO_BASE_ID,
        parallelId: BLUE_REFRACTOR_150_ID,
        parallel: "Blue Refractor",
        isAuto: true,
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(detailMock).not.toHaveBeenCalled();
    expect(result.priceSourceInternal).toBe("cardsight-parallel-id");
    expect(result.priceSource).toBe("exact");
    expect(result.compsUsed).toBeGreaterThanOrEqual(3);
  });
});
