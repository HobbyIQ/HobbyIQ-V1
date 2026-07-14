// CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14): pins the
// reference-catalog hookup on cardIdSuggester. Every suggestion (and
// alternative) resolves its (year, product, parallel) against the
// Phase 4 catalog data — matches carry catalogVerified with the
// canonical form; misses/env-off carry null.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
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
vi.mock("../src/services/compiq/referenceCatalogLookup.js", () => ({
  inferPrintRunFromReferenceCatalog: vi.fn(),
}));

import { suggestCardIdForHolding } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import { inferPrintRunFromReferenceCatalog } from "../src/services/compiq/referenceCatalogLookup.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1", playerName: "Eric Hartman", cardYear: 2026,
    setName: "Bowman Chrome", parallel: "Green Refractor",
    cardNumber: "CPA-EHA", isAuto: true, quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

beforeEach(() => {
  vi.mocked(searchCards).mockReset().mockResolvedValue([]);
  vi.mocked(fetchCardsightUuidNativeCandidates).mockReset().mockResolvedValue([]);
  vi.mocked(inferPrintRunFromReferenceCatalog).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("CF-CARDID-SUGGESTER-CATALOG-VERIFY", () => {
  it("primary suggestion carries catalogVerified when catalog resolves", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-hartman-green",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Green Refractor", name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99,
      auto: true,
      confidence: "Verified",
      product: "Bowman Chrome",
      cardSet: "Chrome Prospect Autographs",
      parallel: "Green Refractor",
      source: "reference-catalog",
    });

    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.catalogVerified).toEqual({
      confidence: "Verified",
      printRun: 99,
      canonicalProduct: "Bowman Chrome",
      canonicalCardSet: "Chrome Prospect Autographs",
      canonicalParallel: "Green Refractor",
    });
  });

  it("catalogVerified is null when catalog has no match", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-x", set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA", variant: "Green Refractor", name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);

    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.catalogVerified).toBeNull();
  });

  it("catalogVerified is null when env flag is off (lookup returns null itself)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-x", set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA", variant: "Green Refractor", name: "Eric Hartman",
      } as any,
    ]);
    // Env-off path: the real lookup returns null when
    // COMPIQ_REFERENCE_CATALOG_ENABLED !== "true". We mock that.
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);

    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.catalogVerified).toBeNull();
  });

  it("catalog lookup THROWING does not fail the suggestion (fire-and-swallow)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-x", set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA", variant: "Green Refractor", name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockRejectedValue(new Error("Cosmos down"));

    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    expect(r?.cardId).toBe("ch-x");
    expect(r?.catalogVerified).toBeNull();
  });

  it("alternatives ALSO carry catalogVerified independently of primary", async () => {
    // Two candidates. Force medium tier via cardYear mismatch so alts emit.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-primary",
        set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Green Refractor", name: "Eric Hartman",
      } as any,
      {
        card_id: "ch-alt",
        set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Purple Refractor", name: "Eric Hartman",
      } as any,
    ]);
    // Return catalog hit for Green (primary), miss for Purple (alt)
    vi.mocked(inferPrintRunFromReferenceCatalog).mockImplementation(async (_p, _y, parallel) => {
      if (String(parallel).toLowerCase().includes("green")) {
        return {
          printRun: 99, auto: true, confidence: "High",
          product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
          parallel: "Green Refractor", source: "reference-catalog",
        };
      }
      return null;
    });

    const r = await suggestCardIdForHolding(makeHolding({ cardYear: 2025 }));
    expect(r?.confidenceTier).not.toBe("high");
    expect(r?.catalogVerified?.canonicalParallel).toBe("Green Refractor");
    expect(r?.alternatives).toBeDefined();
    const alt = r?.alternatives?.find((a) => a.cardId === "ch-alt");
    expect(alt).toBeDefined();
    expect(alt?.catalogVerified).toBeNull();
  });

  it("catalog lookup fires with the candidate's normalized fields (not raw holding)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-x", set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA", variant: "Green Refractor", name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);

    // Holding with messy fields — normalizer strips "2026 " prefix + subset words
    await suggestCardIdForHolding(makeHolding({
      setName: "2026 Bowman Chrome",
      parallel: "Chrome Green Refractor",
    }));

    // Lookup is called with the CANDIDATE'S set/variant (from the CH row),
    // not the raw holding fields — the candidate is what's being verified.
    expect(inferPrintRunFromReferenceCatalog).toHaveBeenCalled();
    const args = vi.mocked(inferPrintRunFromReferenceCatalog).mock.calls[0];
    expect(args[0]).toBe("2026 Bowman Baseball");   // candidate.set
    expect(args[1]).toBe(2026);                      // candidate.year (coerced)
    expect(args[2]).toBe("Green Refractor");         // candidate.variant
  });
});
