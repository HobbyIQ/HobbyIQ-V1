/**
 * Issue #24 — recentComps display fix.
 *
 * Previously the engine emitted recentComps from the post-`normalizeCompToRaw`
 * pool, which divided every comp's sale price by its grader premium. For a
 * PSA 7 query (premium 0.95) the iOS UI saw fractional-cent-adjusted prices
 * instead of the real Card Hedge sale price.
 *
 * The fix preserves the original CH sale price on each comp object and
 * exposes it as the recentComps[].price, while internal anchor math
 * continues to use the normalized value. Every recentComps entry now also
 * carries an explicit `grade` field so the iOS UI does not have to parse
 * the title.
 *
 * Internal pricing math (FMV, anchor, premium re-application) is intentionally
 * NOT asserted here — only the display layer contract.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's findCompsRouted return
// shape (RoutedResult) matches the prior cardhedge findCompsByQuery shape.
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

const today = new Date();
const isoDaysAgo = (n: number) =>
  new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

interface RecentComp {
  price: number;
  title: string;
  soldDate: string;
  grade: string;
}

describe("recentComps display (issue #24)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PSA 7 target: recentComps surfaces ORIGINAL CH sale prices (not normalized intermediates)", async () => {
    const psa7Prices = [100, 110, 95, 105, 120, 115, 98, 102];
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-test-psa7",
        title: "Ronald Acuna Jr 2018 Topps Update PSA 7",
        player: "Ronald Acuna Jr",
        set: "2018 Topps Update",
        year: "2018",
        number: "US250",
        variant: "Base",
      },
      sales: psa7Prices.map((price, i) => ({
        price,
        date: isoDaysAgo(i),
        grade: "PSA 7",
        source: "card_hedge",
        sale_type: "auction",
        title: `Ronald Acuna Jr 2018 Topps Update US250 PSA 7 #${i}`,
        url: null,
      })),
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Ronald Acuna Jr 2018 Topps Update",
      gradeCompany: "PSA",
      gradeValue: 7,
    } as any, testCallContext)) as Record<string, unknown>;

    const recent = result.recentComps as RecentComp[];
    expect(Array.isArray(recent)).toBe(true);
    expect(recent.length).toBeGreaterThan(0);

    // PSA 7 premium is 0.95 — if the OLD bug were still present we'd see
    // values like price * (1/0.95). Set-membership in the supplied
    // originals is already sufficient proof that no normalization slipped
    // into the display layer.
    const originalsSet = new Set(psa7Prices);
    for (const c of recent) {
      expect(originalsSet.has(c.price)).toBe(true);
      expect(c.grade).toBe("PSA 7");
      expect(typeof c.title).toBe("string");
      expect(typeof c.soldDate).toBe("string");
    }
  });

  it("Mixed-grade pool (no grade specified): each comp's grade label is derived from its own title", async () => {
    const sales = [
      { price: 200, grade: "PSA 7", title: "Cross Player 2020 Topps PSA 7 A" },
      { price: 220, grade: "PSA 7", title: "Cross Player 2020 Topps PSA 7 B" },
      { price: 210, grade: "PSA 7", title: "Cross Player 2020 Topps PSA 7 C" },
      { price: 380, grade: "PSA 9", title: "Cross Player 2020 Topps PSA 9 A" },
      { price: 400, grade: "PSA 9", title: "Cross Player 2020 Topps PSA 9 B" },
      { price: 390, grade: "PSA 9", title: "Cross Player 2020 Topps PSA 9 C" },
    ];
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-test-crossgrade",
        title: "Cross Grade Test Card",
        player: "Cross Player",
        set: "2020 Topps",
        year: "2020",
        number: "1",
        variant: "Base",
      },
      sales: sales.map((s, i) => ({
        price: s.price,
        date: isoDaysAgo(i),
        grade: s.grade,
        source: "card_hedge",
        sale_type: "auction",
        title: s.title,
        url: null,
      })),
      variantWarning: [],
      aiCategory: "Baseball",
    });

    // No gradeCompany / gradeValue supplied → engine should NOT filter by
    // grade, so both PSA 7 and PSA 9 comps remain in the pool.
    const result = (await computeEstimate({
      playerName: "Cross Player",
    } as any, testCallContext)) as Record<string, unknown>;

    const recent = result.recentComps as RecentComp[];
    expect(Array.isArray(recent)).toBe(true);

    const originalPrices = new Set(sales.map((s) => s.price));
    const titleToGrade = new Map(sales.map((s) => [s.title, s.grade]));

    let sawPsa7 = false;
    let sawPsa9 = false;
    for (const c of recent) {
      expect(originalPrices.has(c.price)).toBe(true);
      const expected = titleToGrade.get(c.title);
      if (expected) expect(c.grade).toBe(expected);
      if (c.grade === "PSA 7") sawPsa7 = true;
      if (c.grade === "PSA 9") sawPsa9 = true;
    }
    expect(sawPsa7).toBe(true);
    expect(sawPsa9).toBe(true);
  });

  it("Raw target: prices unchanged and grade label is \"Raw\" when title has no grading company", async () => {
    const rawPrices = [50, 55, 48, 52, 60, 58, 49, 51];
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-test-raw",
        title: "Raw Test Card",
        player: "Raw Player",
        set: "2022 Topps",
        year: "2022",
        number: "5",
        variant: "Base",
      },
      sales: rawPrices.map((price, i) => ({
        price,
        date: isoDaysAgo(i),
        grade: "Raw",
        source: "card_hedge",
        sale_type: "buy_it_now",
        // No PSA/BGS/SGC/CGC token in the title -> formatGradeLabel should
        // fall back to "Raw".
        title: `Raw Player 2022 Topps #5 ungraded #${i}`,
        url: null,
      })),
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Raw Player",
    } as any, testCallContext)) as Record<string, unknown>;

    const recent = result.recentComps as RecentComp[];
    expect(Array.isArray(recent)).toBe(true);
    expect(recent.length).toBeGreaterThan(0);

    const originals = new Set(rawPrices);
    for (const c of recent) {
      expect(originals.has(c.price)).toBe(true);
      expect(c.grade).toBe("Raw");
    }
  });
});
