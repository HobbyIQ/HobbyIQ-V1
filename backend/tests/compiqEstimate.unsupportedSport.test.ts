/**
 * Coverage for issue #7 — computeEstimate's unsupported-sport guard.
 *
 * When Card Hedge's AI match identifies the card as a non-baseball sport
 * (Basketball, Football, etc.), computeEstimate must short-circuit with
 * source="unsupported_sport", null pricing fields, and a populated
 * `unsupportedSportReason`/`detectedSport`. It must NOT fall through to
 * neighbor synthesis or any pricing math.
 *
 * Without this guard, case-15 (1986 Fleer Michael Jordan PSA 8) was
 * being mis-priced as a 1991 UD Baseball novelty at ~$46.
 *
 * Mocks the Card Hedge client at the module boundary so the entire
 * pricing pipeline runs against deterministic inputs.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's findCompsRouted return
// shape (RoutedResult) matches the prior cardhedge findCompsByQuery shape.
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

describe("computeEstimate — unsupported-sport guard (issue #7)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits with source=unsupported_sport when CH AI identifies Basketball", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-jordan-basketball-test",
        title: "Michael Jordan 1986 Fleer Basketball Rookie",
        player: "Michael Jordan",
        set: "1986 Fleer Basketball",
        year: "1986",
        number: "57",
        variant: "Base",
      },
      sales: [
        { price: 12000, date: "2026-05-10", grade: "PSA 8", source: "card_hedge", sale_type: "auction", title: "Jordan 1986 Fleer PSA 8", url: null },
      ],
      variantWarning: [],
      aiCategory: "Basketball",
    });

    const result = (await computeEstimate({
      playerName: "1986 Fleer Michael Jordan PSA 8",
      gradeCompany: "PSA",
      gradeValue: 8,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("unsupported_sport");
    expect(typeof result.unsupportedSportReason).toBe("string");
    expect((result.unsupportedSportReason as string).toLowerCase()).toContain("basketball");
    expect(result.detectedSport).toBe("Basketball");
    expect(result.fairMarketValue).toBe(0);
    expect(result.compsUsed).toBe(0);
    expect(result.recentComps).toEqual([]);
  });

  it("does NOT short-circuit when CH AI identifies Baseball", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-trout-baseball-test",
        title: "Mike Trout 2011 Topps Update Baseball",
        player: "Mike Trout",
        set: "2011 Topps Update Baseball",
        year: "2011",
        number: "US175",
        variant: "Base",
      },
      sales: Array.from({ length: 8 }, (_, i) => ({
        price: 150 + i,
        date: isoDaysAgo(i),
        grade: "Raw",
        source: "card_hedge",
        sale_type: "buy_it_now",
        title: "Mike Trout 2011 Topps Update US175",
        url: null,
      })),
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Mike Trout 2011 Topps Update",
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).not.toBe("unsupported_sport");
    expect(result.unsupportedSportReason).toBeUndefined();
  });

  it("does NOT short-circuit when aiCategory is null (no AI match)", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-fallback-baseball",
        title: "Some Baseball Card",
        player: "Some Player",
        set: "2024 Topps",
        year: "2024",
        number: "100",
        variant: "Base",
      },
      sales: Array.from({ length: 8 }, (_, i) => ({
        price: 20 + i,
        date: isoDaysAgo(i),
        grade: "Raw",
        source: "card_hedge",
        sale_type: "buy_it_now",
        title: "Some Player 2024 Topps 100",
        url: null,
      })),
      variantWarning: [],
      aiCategory: null,
    });

    const result = (await computeEstimate({
      playerName: "2024 Topps Some Player",
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).not.toBe("unsupported_sport");
  });

  it("short-circuits with source=unsupported_sport when CH AI identifies Football", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-herbert-football-test",
        title: "Justin Herbert 2020 Panini Prizm",
        player: "Justin Herbert",
        set: "2020 Panini Prizm Football",
        year: "2020",
        number: "325",
        variant: "Base",
      },
      sales: [
        { price: 200, date: "2026-05-10", grade: "PSA 10", source: "card_hedge", sale_type: "auction", title: "Herbert Prizm PSA 10", url: null },
      ],
      variantWarning: [],
      aiCategory: "Football",
    });

    const result = (await computeEstimate({
      playerName: "2020 Panini Prizm Justin Herbert PSA 10",
      gradeCompany: "PSA",
      gradeValue: 10,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("unsupported_sport");
    expect(result.detectedSport).toBe("Football");
    expect((result.unsupportedSportReason as string).toLowerCase()).toContain("football");
    expect(result.fairMarketValue).toBe(0);
  });
});
