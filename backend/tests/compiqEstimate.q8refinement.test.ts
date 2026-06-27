// CF-VARIANT-FILTER-LOOSENING Q8'' refinement — variantWarning subcase
// disambiguation. The original Q8 lock conflated two cases; Q8' first
// refinement (parallelNotFound → short-circuit) over-narrowed; Q8''
// requires BOTH parallelNotFound AND autoPrefixMismatch.
//
// Canonical fixture: Gage Wood Gold Auto. Production sweep on 2026-05-26
// surfaced this case promoting to T2 with $2 FMV because Cardsight
// resolved to the BASE BDC-4 prospect (not the Gold Auto numbered).
// Auto-prefix mismatch (user requested isAuto=true, resolved cardId.number
// "BDC-4" has no auto prefix) is the structural fingerprint of wrong-card
// resolution.
//
// Right-card-different-parallel cases (Trout Wal-Mart Border, Maddux
// TIFFANY, John Gil Gold) have parallelNotFound=true but NO auto-prefix
// mismatch — Cardsight resolved the right base card and the user wanted
// a base parallel. Tier ladder T1 rescue is legitimate there.

import { describe, it, expect, vi } from "vitest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's findCompsRouted return
// shape (RoutedResult) is identical to the prior cardhedge findCompsByQuery
// shape, so mock fixtures port verbatim.
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

describe("Q8'' — Cardsight wrong-card-resolution short-circuit (parallelNotFound + autoPrefixMismatch)", () => {
  it("Gage Wood Gold Auto (wrong-card: auto requested → BASE BDC-4 resolved): SHORT-CIRCUITS", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "26fae2a4-2f50-460a-9f74-175f4840faef",
        title: "Gage Wood",
        player: "Gage Wood",
        set: "Chrome Prospects", // CF-FIXTURE-AUDIT: BDC- (Bowman Draft Chrome) base prefix → "Chrome Prospects" subset
        year: 2025,
        // BDC-4 = Bowman Draft Chrome BASE (NOT an auto prefix). With
        // user.isAuto=true, this is autoPrefixMismatch=true.
        number: "BDC-4",
        variant: null,
      },
      sales: Array.from({ length: 16 }, (_, i) => ({
        price: 1 + (i % 4),
        date: isoDaysAgo(i),
        title: `2025 Bowman Draft #BDC-4 Gage Wood Chrome ${i % 2 ? "Refractor" : ""}`,
      })),
      variantWarning: [
        "3 candidates have pricing data; picked highest (117 records).",
        "Parallel \"Gold\" not found among 33 parallel(s) — returning cardId only.",
      ],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Gage Wood",
      cardYear: 2025,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    expect(result.source).toBe("variant-mismatch");
    expect(result.marketValue).toBeNull();
    expect(result.fairMarketValue).toBeNull();
    expect(result.compQuality?.tierLadderTrace).toEqual({ T0: 0, T1: 0, T2: 0, T3: 0 });
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBe(16);
    // Verdict text surfaces the Q8'' diagnostic phrase.
    expect(String(result.verdict)).toMatch(/cardsight wrong-card resolution/i);
    expect(result.compsUsed).toBe(0);
    expect(result.compsAvailable).toBe(16);
  });

  it("Bonemer Blue base (wrong-card: base requested → AUTO CPA-CBO resolved): SHORT-CIRCUITS (XOR direction)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "496a7e19-b26d-4f48-9fae-e66d6961c27a",
        title: "Caleb Bonemer",
        player: "Caleb Bonemer",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA- prefix → CPA subset
        year: 2024,
        // CPA-CBO = Chrome Prospect Autograph (AUTO prefix). With
        // user.isAuto=false, this is autoPrefixMismatch=true (other direction).
        number: "CPA-CBO",
        variant: null,
      },
      sales: Array.from({ length: 6 }, (_, i) => ({
        price: 100 + i * 5,
        date: isoDaysAgo(i),
        title: `2024 Bowman Draft Caleb Bonemer Chrome Auto 1st Prospect #CPA-CBO`,
      })),
      variantWarning: [
        "No candidates matched release \"bowman chrome\" — picking from top-ranked results.",
        "2 candidates have pricing data; picked highest (72 records).",
        "Parallel \"Blue\" not found among 22 parallel(s) — returning cardId only.",
      ],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Blue",
      isAuto: false,
    } as any, testCallContext)) as Record<string, any>;

    expect(result.source).toBe("variant-mismatch");
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBe(6);
    expect(String(result.verdict)).toMatch(/cardsight wrong-card resolution/i);
  });

  it("Mike Trout Wal-Mart Border Blue (right-card-different-parallel: BASE US175, no auto): TIER LADDER APPLIES", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "fda530ab-e925-460e-ab88-63199ef975e9",
        title: "Mike Trout",
        player: "Mike Trout",
        set: "Topps Update",
        year: 2011,
        // US175 = base card number (NOT auto prefix). user.isAuto=false.
        // autoPrefixMismatch=false → Q8'' does NOT fire. Tier ladder runs.
        number: "US175",
        variant: null,
      },
      sales: Array.from({ length: 5 }, (_, i) => ({
        price: 350 + i * 10,
        date: isoDaysAgo(i),
        title: `2011 Topps Update Series Mike Trout #US175 (RC)`,
      })),
      variantWarning: [
        "Parallel \"Blue\" not found among 9 parallel(s) — returning cardId only.",
      ],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      parallel: "Blue",
      isAuto: false,
    } as any, testCallContext)) as Record<string, any>;

    // Q8'' does NOT fire (autoPrefixMismatch=false). Tier ladder runs.
    // T0 rejects all comps for parallel_mismatch (no "blue" in titles).
    // T1 drops parallel rejection → all 5 comps survive → live pricing.
    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(typeof result.marketValue).toBe("number");
    expect(result.marketValue).toBeGreaterThan(0);
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBeUndefined();
  });

  it("Hypothetical: AUTO requested + resolved cardId IS AUTO (CPA prefix) + parallelNotFound: TIER LADDER APPLIES", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // Right-card auto case: user wants auto + Gold parallel; Cardsight
    // resolves the auto card_id (CPA-XYZ) but lacks the Gold parallel
    // separately. autoPrefixMismatch=false (both auto) → ladder runs.
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-some-auto",
        title: "Some Prospect Auto",
        player: "Some Prospect",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-XYZ prefix → CPA subset
        year: 2025,
        number: "CPA-XYZ", // AUTO prefix, matches user.isAuto=true
        variant: null,
      },
      sales: Array.from({ length: 4 }, (_, i) => ({
        price: 50 + i * 10,
        date: isoDaysAgo(i),
        title: `2025 Bowman Chrome Some Prospect Auto #CPA-XYZ Refractor`,
      })),
      variantWarning: [
        "Parallel \"Gold\" not found among 50 parallel(s) — returning cardId only.",
      ],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Some Prospect",
      cardYear: 2025,
      product: "Bowman Chrome",
      parallel: "Gold",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    // Q8'' does NOT fire (both auto, no mismatch). T1 rescue legitimate.
    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBeUndefined();
  });

  it("Drake Baldwin Blue Refractor Auto (auto_mismatch warning only, NO 'returning cardId only'): TIER LADDER APPLIES", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // Q8 original case: no parallelNotFound warning at all → Q8'' detection
    // skips this branch entirely → tier ladder applies.
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-drake-blue-auto-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN prefix → CPA subset
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      ],
      variantWarning: ["auto_mismatch"],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(typeof result.marketValue).toBe("number");
    expect(result.marketValue).toBeGreaterThan(0);
  });

  it("everythingFilteredOut without any variantWarning: TIER LADDER APPLIES (no Q8'' interference)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-x",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN prefix → CPA subset
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBeUndefined();
  });
});
