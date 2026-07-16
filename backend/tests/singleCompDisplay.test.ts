// CF-SINGLE-COMP-DISPLAY (Drew, 2026-07-14) — pins the fix that keeps
// the on-screen price visible when a card has only 1 or 2 usable comps.
// Before this fix, the compiq engine null'd fairMarketValue whenever
// dataSufficiency.sufficient was false (i.e. usedComps < 3), which
// meant new-release cards like Hartman 2026 Blue Refractor Auto showed
// a blank price until three sales existed. The single-sale median IS
// the market for that sub-market until more comps arrive — hide the
// number only when we have zero.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardhedge.client.js")>();
  return {
    ...actual,
    identifyCard: vi.fn(),
    getTrustedComps: vi.fn(),
  };
});

vi.mock("../src/services/compiq/catalogSource.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/catalogSource.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
    resolveCardId: vi.fn(),
  };
});

vi.mock(import("../src/services/shared/cache.service.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cacheWrap: async (_key: string, fn: () => Promise<unknown>) => fn(),
  };
});

import { identifyCard, getTrustedComps } from "../src/services/compiq/cardhedge.client.js";
import { getPricing, getCardDetail, searchCatalog, resolveCardId } from "../src/services/compiq/catalogSource.js";
import { computeEstimate, evaluateDataSufficiency } from "../src/services/compiq/compiqEstimate.service.js";

const mockIdentifyCard = vi.mocked(identifyCard);
const mockGetTrustedComps = vi.mocked(getTrustedComps);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);
const mockSearchCatalog = vi.mocked(searchCatalog);
const mockResolveCardId = vi.mocked(resolveCardId);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const HARTMAN_CH_ID = "1778542093014x623522278065749040";

function buildCsPricing(records: Array<{ price: number; date: string; title?: string }>) {
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
        price: r.price, date: r.date, title: r.title ?? "raw", parallel_id: null,
      })),
    },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[records.length - 1]?.date ?? null },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardDetail.mockResolvedValue({
    notFound: false, releaseName: "Bowman", year: "2026", parallels: [],
  } as any);
  mockResolveCardId.mockResolvedValue({
    cardId: HARTMAN_CS_ID, parallelId: null, matchConfidence: "exact", warnings: [],
  } as any);
  mockSearchCatalog.mockResolvedValue([
    {
      id: HARTMAN_CS_ID,
      name: "Eric Hartman Blue Refractor Auto",
      number: "CPA-EHA",
      releaseName: "2026 Bowman Baseball",
      setName: "2026 Bowman Baseball",
      year: 2026,
      player: "Eric Hartman",
    },
  ] as any);
});

afterEach(() => vi.restoreAllMocks());

describe("evaluateDataSufficiency — level='very_thin' still marks sufficient=false (unchanged)", () => {
  it("1 usable comp → level='very_thin', not 'none'", () => {
    const v = evaluateDataSufficiency({ usedComps: 1, totalComps: 1, recentCount: 1 });
    expect(v.level).toBe("very_thin");
    expect(v.sufficient).toBe(false);
  });
  it("0 usable comps → level='none'", () => {
    const v = evaluateDataSufficiency({ usedComps: 0, totalComps: 5, recentCount: 0 });
    expect(v.level).toBe("none");
    expect(v.sufficient).toBe(false);
  });
});

describe("CF-SINGLE-COMP-DISPLAY — CH-trusted 1-comp path emits marketValue", () => {
  // Production path: CH bridge returns 1 trusted comp → isChTrustedSingleSaleForce
  // forces insufficient=true → engine emits response via the thin-branch path.
  // Prior behavior: marketValue=null, iOS was expected to render lastSale.price
  // + estimateSource="live-market-last-sale" but doesn't — so the price was blank.
  // Fix: populate marketValue from lastSale.price on that branch.

  it("CH-trusted 1 comp → marketValue = last-sale price (fairMarketValue still null for training gate)", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.97 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true,
      reason: "prices_by_card_honest",
      comps: [
        { price: 420, date: "2026-07-05", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Blue Refractor Auto", url: null },
      ],
      median: 420,
      count: 1,
      newestDate: "2026-07-05",
      pricesByCardLength: 1,
    } as any);
    // CS pricing is fetched for divergence telemetry; keep it healthy.
    mockGetPricing.mockResolvedValue(buildCsPricing([
      { price: 420, date: "2026-07-05" },
    ]));

    const result = await computeEstimate({
      cardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue Refractor Auto",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Drew's ask: single-comp cards MUST show a price.
    expect((result as any).marketValue).toBe(420);
    // Training gate preserved (structural exclusion — see comment at
    // compiqEstimate.service.ts:5911).
    expect(result.fairMarketValue).toBeNull();
    // The estimateSource still labels this as a live-market-last-sale
    // read so iOS can badge it "1 comp" if it wants.
    expect((result as any).estimateSource).toBe("live-market-last-sale");
    // Last-sale echo still present for backwards compat.
    expect((result as any).lastSale?.price).toBe(420);
  });

  it("CH-trusted 0 comps (empty pool) → marketValue null (nothing to show honestly)", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.97 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: false, reason: "no_data", comps: [], median: null, count: 0,
      newestDate: null, pricesByCardLength: 0,
    } as any);
    mockGetPricing.mockResolvedValue(buildCsPricing([]));

    const result = await computeEstimate({
      cardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue Refractor Auto",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Zero comps AND no lastSale anchor: marketValue is null (honest empty).
    expect((result as any).marketValue).toBeNull();
    expect(result.fairMarketValue).toBeNull();
  });
});
