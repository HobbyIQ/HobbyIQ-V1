// CF-VARIANT-FILTER-LOOSENING Q8' refinement — variantWarning subcase
// disambiguation: parallel-not-found short-circuits the tier ladder
// (Cardsight wrong-card resolution); auto/serial mismatch still applies
// the ladder per original Q8 intent.
//
// Canonical fixture: Gage Wood Gold Auto. Production sweep on 2026-05-26
// surfaced this case promoting to T2 with $2 FMV because Cardsight
// resolved to the BASE BDC-4 prospect (not the Gold Auto numbered) and
// returned 16 base/refractor comps. T2 dropped both parallel + auto
// filters and accepted the wrong-card pool. The variantWarning token
// "Parallel 'Gold' not found among 33 parallel(s) — returning cardId
// only" is the explicit wrong-card signal we now short-circuit on.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("Q8' — Cardsight wrong-card-resolution short-circuits tier ladder", () => {
  it("Gage Wood Gold Auto: parallel-not-found variantWarning bypasses ladder, returns variant-mismatch (not T2 $2)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // Cardsight resolved to the BASE BDC-4 card (Gold Auto not in catalog)
    // and returned 16 base/refractor comps. variantWarning includes the
    // canonical "returning cardId only" signal.
    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "26fae2a4-2f50-460a-9f74-175f4840faef",
        title: "Gage Wood",
        player: "Gage Wood",
        set: "Bowman Draft",
        year: 2025,
        number: "BDC-4",
        variant: null,
      },
      // 16 base/refractor comps, none with auto or Gold in title — would
      // pass T2 (drops parallel + auto rejection) and produce ~$2 median
      // pre-Q8'.
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
    } as any)) as Record<string, any>;

    // Q8' refinement: source is variant-mismatch (NOT live T2).
    expect(result.source).toBe("variant-mismatch");
    expect(result.marketValue).toBeNull();
    expect(result.fairMarketValue).toBeNull();

    // Tier ladder was skipped entirely — trace shows all zeros.
    expect(result.compQuality?.tierLadderTrace).toEqual({ T0: 0, T1: 0, T2: 0, T3: 0 });

    // Rejection bucket carries the Q8' signal name for diagnostics.
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBe(16);

    // Verdict text surfaces the Q8' phrasing ("Cardsight wrong-card
    // resolution detected" inside the missing-reasons string).
    expect(String(result.verdict)).toMatch(/cardsight wrong-card resolution|returning cardid only/i);

    // compsUsed=0, compsAvailable=16 — UI can show "16 comps on file but
    // none match the requested card".
    expect(result.compsUsed).toBe(0);
    expect(result.compsAvailable).toBe(16);
  });

  it("Drake Baldwin Blue Refractor Auto (auto_mismatch warning only): tier ladder still applies per original Q8", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // Same shape as the canonical Drake Baldwin T1-promotion fixture but
    // with ONLY an auto_mismatch warning (no "returning cardId only").
    // This is the Q8-original case: Cardsight has the right card; uncertain
    // about variant attribute. Tier ladder should still rescue.
    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-drake-blue-auto-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Bowman Chrome",
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      ],
      variantWarning: ["auto_mismatch"], // NO "returning cardId only"
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any)) as Record<string, any>;

    // Auto/serial subcase: ladder still applies → T1 rescue → live source.
    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(typeof result.marketValue).toBe("number");
    expect(result.marketValue).toBeGreaterThan(0);
  });

  it("everythingFilteredOut without any variantWarning: tier ladder applies (no Q8' interference)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // No variantWarning at all. Strict filter would reject for parallel.
    // Tier ladder T1 should fire (drop parallel), producing live pricing.
    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-x",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Bowman Chrome",
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      ],
      variantWarning: [], // empty
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any)) as Record<string, any>;

    expect(result.source).toBe("live");
    expect(result.compQuality?.variantStrictness).toBe("T1");
    expect(result.compQuality?.reasons?.cardsight_wrong_card).toBeUndefined();
  });
});
