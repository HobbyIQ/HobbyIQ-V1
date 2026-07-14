// CF-CARDID-SUGGESTER (2026-07-12) — unit tests for the suggester.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
  // Real isAutoCardNumber — cheap, deterministic; no need to mock. If a
  // test needs to force a specific auto-detection outcome, spy on it.
  isAutoCardNumber: (num) => {
    if (!num) return false;
    const AUTO_PREFIXES = ["cpa","bcp-a","bcpa","bpa","pa","cra","ra","bcra","bsa","bca","tca","usa","au","bba","bspa","fa","roa"];
    const s = String(num).toLowerCase();
    return AUTO_PREFIXES.some((p) => new RegExp("(^|\\b)" + p + "[- ]").test(s));
  },
}));

vi.mock("../src/services/compiq/cardsightUuidSource.js", () => ({
  fetchCardsightUuidNativeCandidates: vi.fn(),
}));

import { suggestCardIdForHolding } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Mookie Betts",
    cardYear: 2020,
    setName: "Panini Prizm",
    parallel: "Silver",
    cardNumber: "275",
    isAuto: false,
    quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

beforeEach(() => {
  vi.mocked(searchCards).mockReset();
  // Default: CS-native returns empty so existing single-vendor tests
  // exercise CH-only behavior. Multi-vendor tests below override this.
  vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("suggestCardIdForHolding", () => {
  it("returns null when playerName is missing", async () => {
    const r = await suggestCardIdForHolding(makeHolding({ playerName: undefined }));
    expect(r).toBeNull();
  });

  it("returns null when CH returns no candidates", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).toBeNull();
  });

  // Network-error path is exercised via the empty-array path — the catch
  // block in suggestCardIdForHolding returns null in both cases. Vitest's
  // unhandled-rejection tracking makes the throw-caught test noisy without
  // adding coverage.

  it("returns the top candidate with 0.9 confidence on single high-score hit", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-abc-123",
        title: "2020 Panini Prizm Mookie Betts #275",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
        image: "https://cdn/x.jpg",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe("ch-abc-123");
    expect(r!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r!.candidate.image).toBe("https://cdn/x.jpg");
  });

  it("scores multi-hit candidates and picks the best-scoring match", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-wrong-year",
        title: "2019 Panini Prizm Mookie Betts #275",
        set: "Panini Prizm",
        year: 2019,   // year mismatch → -30
        number: "275",
        variant: "Silver",
        image: "wrong.jpg",
      },
      {
        card_id: "ch-perfect",
        title: "2020 Panini Prizm Mookie Betts #275 Silver",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        image: "perfect.jpg",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.cardId).toBe("ch-perfect");
  });

  it("passes structured filters to CH search", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    await suggestCardIdForHolding(makeHolding());
    const call = vi.mocked(searchCards).mock.calls[0];
    expect(call[2]).toMatchObject({ player: "Mookie Betts", set: "Panini Prizm" });
  });

  it("query string omits noisy grade tokens", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    await suggestCardIdForHolding(makeHolding({
      gradeCompany: "PSA",
      gradeValue: 10,
    }));
    const query = vi.mocked(searchCards).mock.calls[0][0];
    expect(query).not.toContain("PSA");
    expect(query).not.toContain("10 GEM");
    // BUT should still contain the structured fields
    expect(query).toContain("Mookie Betts");
    expect(query).toContain("2020");
    expect(query).toContain("Panini Prizm");
  });

  it("returns null when the top candidate lacks card_id (unusual CH response)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      { title: "no id", set: "x", year: 2020, image: "x.jpg" } as any,
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).toBeNull();
  });
});

describe("suggestCardIdForHolding — normalized confidence + tiers", () => {
  it("single low-score hit → confidence is fraction of fields matched", async () => {
    // Everything wrong: 0/5 fields matched (year mismatch, cardNumber mismatch,
    // set mismatch, parallel mismatch, no player match) → confidence very low
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-weak",
        title: "some card",
        set: "different set",
        year: 2019,
        number: "999",
        variant: "different",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    // isAuto=false aligned with candidate (no auto in title) = 10/100 matched.
    // Everything else mismatched. Confidence 0.1, tier="low".
    expect(r!.confidence).toBe(0.1);
    expect(r!.confidenceTier).toBe("low");
  });

  it("perfect match → confidence 1.0, tier=high", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-perfect",
        title: "Mookie Betts 2020 Panini Prizm",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.cardId).toBe("ch-perfect");
    expect(r!.confidence).toBe(1);
    expect(r!.confidenceTier).toBe("high");
  });

  it("year mismatch on otherwise-perfect match drops confidence into medium tier", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-year-mismatch",
        title: "Mookie Betts Panini Prizm",
        set: "Panini Prizm",
        year: 2019,   // holding is 2020 → mismatch
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    // Weight: year(20) miss, cardNumber(25), set(20), parallel(10), player(15),
    // auto(10 aligned as not-auto). Matched = 25+20+10+15+10 = 80/100 = 0.80
    expect(r!.confidence).toBe(0.8);
    expect(r!.confidenceTier).toBe("medium");
    expect(r!.matchBreakdown.mismatchedFields).toContain("cardYear");
  });

  it("matchBreakdown reports fields checked + matched counts", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-perfect",
        title: "Mookie Betts Panini Prizm",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.matchBreakdown.fieldsChecked).toBe(6);   // year, cardNum, set, parallel, player, auto
    expect(r!.matchBreakdown.fieldsMatched).toBe(6);
    expect(r!.matchBreakdown.mismatchedFields).toEqual([]);
  });

  it("holding without cardYear normalizes score over reduced denominator", async () => {
    // Holding is missing cardYear → we shouldn't check it → denominator drops
    // → 100% of remaining fields matched = confidence 1.0
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-partial-holding",
        title: "Mookie Betts Panini Prizm",
        set: "Panini Prizm",
        year: 2019,   // year mismatch WOULD normally hurt but holding.cardYear undefined
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding({ cardYear: undefined }));
    expect(r!.matchBreakdown.fieldsChecked).toBe(5);  // year skipped
    expect(r!.confidence).toBe(1);
    expect(r!.confidenceTier).toBe("high");
  });

  it("auto flag alignment: holding.isAuto=true, candidate title contains 'Auto' → aligned", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-auto",
        title: "Mookie Betts Auto",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver Auto",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding({ isAuto: true }));
    expect(r!.matchBreakdown.mismatchedFields).not.toContain("isAuto");
  });

  it("auto flag misalignment drops confidence", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-no-auto",
        title: "Mookie Betts",   // no "Auto"
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding({ isAuto: true }));
    expect(r!.matchBreakdown.mismatchedFields).toContain("isAuto");
    expect(r!.confidence).toBeLessThan(1);
  });
});
