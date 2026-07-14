// CF-CARDID-SUGGESTER-MULTI-VENDOR + CF-CARDID-SUGGESTER-TOP-N
// (Drew, 2026-07-14) — pins the multi-vendor cardId suggester behavior:
//
//   1. Fires CH search AND CS-native fetch in parallel; unions the pools
//   2. Both scored by the same field-alignment scorer
//   3. Highest score wins the primary suggestion
//   4. CS-native cardId comes back in wire format ({parent}::{parallel})
//   5. Primary tier: "high" tier suppresses alternatives; medium/low
//      surfaces up to 2 alternatives for one-tap resolution
//   6. Dedup across vendors — same physical SKU from CH and CS surfaces
//      only once (primary or alternative, not both)
//   7. Alternative min-score gate: trivially-low candidates are filtered
//
// The Hartman scenario this fixes: CH's catalog has no CPA-EHA Blue
// Refractor Auto SKU, so a CH-only suggester returned a wrong-variant
// pick. CS-native has the SKU exploded from its parallels tree; the
// multi-vendor merge lets the CS row win the primary.

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

import { suggestCardIdForHolding } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import type { CardIdentity } from "../src/types/cardIdentity.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Eric Hartman",
    cardYear: 2026,
    setName: "Bowman Chrome",
    parallel: "Blue Refractor",
    cardNumber: "CPA-EHA",
    isAuto: true,
    quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

function csRow(overrides: Partial<CardIdentity> = {}): CardIdentity {
  return {
    candidateId: "cardsight:00000000-0000-0000-0000-000000000001::00000000-0000-0000-0000-000000000002",
    source: "catalog",
    attribution: "ranked",
    confidence: 0.9,
    player: "Eric Hartman",
    year: 2026,
    brand: null,
    setName: "Bowman Chrome",
    cardNumber: "CPA-EHA",
    parallel: "Blue Refractor",
    variation: null,
    isAuto: true,
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title: "2026 Bowman Chrome Eric Hartman CPA-EHA Blue Refractor",
    imageUrl: "https://cs.cdn/blue-refractor.jpg",
    ...overrides,
  } as CardIdentity;
}

beforeEach(() => {
  vi.mocked(searchCards).mockReset();
  vi.mocked(fetchCardsightUuidNativeCandidates).mockReset();
  // Both vendors default to empty pools so tests that don't override
  // one exercise single-vendor behavior via the OTHER one.
  vi.mocked(searchCards).mockResolvedValue([]);
  vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("CF-CARDID-SUGGESTER-MULTI-VENDOR — Hartman Blue Refractor scenario", () => {
  it("CS wins when CH doesn't catalog the SKU (Hartman Blue Refractor Auto)", async () => {
    // CH returns adjacent variants — none are Blue Refractor.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-cpaeha-blue-xfractor",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Blue X-Fractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA",
        variant: "Blue X-Fractor",  // parallel MISMATCH (partial only)
        name: "Eric Hartman",
      },
      {
        card_id: "ch-cpaeha-refractor",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA",
        variant: "Refractor",  // parallel MISMATCH (looser)
        name: "Eric Hartman",
      },
    ]);
    // CS-native has the exact SKU.
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([csRow()]);

    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    // Primary is the CS row (compound wire cardId, no cardsight: prefix).
    expect(r!.candidateSource).toBe("cardsight-uuid");
    expect(r!.cardId).toBe("00000000-0000-0000-0000-000000000001::00000000-0000-0000-0000-000000000002");
    // Primary carries the CS image + honest variant.
    expect(r!.candidate.variant).toBe("Blue Refractor");
    expect(r!.candidate.image).toBe("https://cs.cdn/blue-refractor.jpg");
  });

  it("CH wins when both vendors have the SKU (CH primary; CS deduped out of alternatives)", async () => {
    // Both vendors return the same physical SKU. CH's row scores identically
    // (same fields align), but CH comes first in the merged pool so on tie
    // CH survives the sort. CS gets deduped out of alternatives.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-cpaeha-green-refractor",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA",
        variant: "Green Refractor",
        name: "Eric Hartman",
      },
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([
      csRow({
        candidateId: "cardsight:00000000-0000-0000-0000-000000000003::00000000-0000-0000-0000-000000000004",
        parallel: "Green Refractor",   // same physical SKU as CH
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
      }),
    ]);
    const r = await suggestCardIdForHolding(makeHolding({ parallel: "Green Refractor" }));
    expect(r!.candidateSource).toBe("cardhedge");
    expect(r!.cardId).toBe("ch-cpaeha-green-refractor");
    // Alternatives should NOT include the duplicate CS row (dedup key
    // year::number::parallel collides).
    expect(r!.alternatives ?? []).toHaveLength(0);
  });

  it("no candidates from EITHER vendor → returns null", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).toBeNull();
  });

  it("CH errors, CS succeeds → CS primary (vendor failure doesn't kill the suggestion)", async () => {
    vi.mocked(searchCards).mockRejectedValue(new Error("CH 500"));
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([csRow()]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    expect(r!.candidateSource).toBe("cardsight-uuid");
  });

  it("CS errors, CH succeeds → CH primary (symmetric failure isolation)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-only", title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Green Refractor",
        name: "Eric Hartman",
      },
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockRejectedValue(new Error("CS 500"));
    const r = await suggestCardIdForHolding(makeHolding({ parallel: "Green Refractor" }));
    expect(r).not.toBeNull();
    expect(r!.candidateSource).toBe("cardhedge");
  });
});

describe("CF-CARDID-SUGGESTER-QUERY-NORMALIZATION — opportunistic set-filter fallback", () => {
  it("retries WITHOUT set filter when strict returned 0 from both vendors", async () => {
    // Strict call (with set filter) returns nothing; relaxed call (without)
    // returns a hit. Both vendors are called for the strict attempt; CH is
    // re-called for the relaxed retry.
    let chCallCount = 0;
    vi.mocked(searchCards).mockImplementation(async (_q, _limit, filters) => {
      chCallCount++;
      // Strict attempt: filters has `set` → return empty
      if (filters && (filters as any).set) return [] as any;
      // Relaxed retry: no set → return a hit
      return [{
        card_id: "ch-relaxed-hit",
        title: "2026 Bowman Baseball Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Green Refractor", name: "Eric Hartman",
      }] as any;
    });
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);

    const r = await suggestCardIdForHolding(makeHolding({
      // Holding's setName "Bowman Chrome" doesn't match CH's "Bowman Baseball"
      // so strict CH filter returns empty; relaxed retry succeeds.
      setName: "Bowman Chrome",
      parallel: "Green Refractor",
    }));
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe("ch-relaxed-hit");
    // Called CH twice: once strict, once relaxed.
    expect(chCallCount).toBe(2);
  });

  it("does NOT retry when strict already returned hits (efficiency)", async () => {
    let chCallCount = 0;
    vi.mocked(searchCards).mockImplementation(async () => {
      chCallCount++;
      return [{
        card_id: "ch-strict-hit",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA",
        variant: "Green Refractor", name: "Eric Hartman",
      }] as any;
    });
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);

    const r = await suggestCardIdForHolding(makeHolding({ parallel: "Green Refractor" }));
    expect(r!.cardId).toBe("ch-strict-hit");
    expect(chCallCount).toBe(1);  // strict only, no retry
  });

  it("does NOT retry when strict returned nothing but there was no set filter to drop", async () => {
    let chCallCount = 0;
    vi.mocked(searchCards).mockImplementation(async () => {
      chCallCount++;
      return [] as any;
    });
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);

    // No setName on the holding → no set filter → nothing to drop → no retry
    const r = await suggestCardIdForHolding(makeHolding({ setName: undefined }));
    expect(r).toBeNull();
    expect(chCallCount).toBe(1);
  });
});

describe("CF-HOLDING-FIELD-NORMALIZER — suggester runs on cleaned fields", () => {
  it("normalizes '2026 2026 Bowman' year-doubling before querying CH", async () => {
    let capturedQuery: string | undefined;
    vi.mocked(searchCards).mockImplementation(async (q) => {
      capturedQuery = q;
      return [] as any;
    });
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);

    await suggestCardIdForHolding(makeHolding({
      cardYear: 2026,
      setName: "2026 Bowman",  // year prefix doubles with cardYear
      parallel: "Green Refractor",
    }));

    // Post-normalize query should NOT contain "2026 2026"; setName stripped
    // to "Bowman" via R1.
    expect(capturedQuery).toBeDefined();
    expect(capturedQuery).not.toMatch(/2026\s+2026/);
    expect(capturedQuery).toContain("2026");
    expect(capturedQuery).toContain("Bowman");
  });

  it("scoring uses normalized fields — 'Chrome Refractor' holding matches 'Refractor' candidate", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-refractor",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA",
        variant: "Refractor",  // Clean parallel name
        name: "Eric Hartman",
      },
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);

    // Holding.parallel="Chrome Refractor" — pre-normalize this would
    // MISMATCH candidate variant="Refractor" via the tightened equality
    // rule. Post-normalize (R3 strips "Chrome" prefix) the holding parallel
    // becomes "Refractor" and matches the candidate exactly.
    const r = await suggestCardIdForHolding(makeHolding({
      parallel: "Chrome Refractor",
      cardYear: 2026,
      setName: "Bowman Chrome",
    }));
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe("ch-refractor");
    // Should score well — parallel matches after normalization
    expect(r!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe("CF-CARDID-SUGGESTER-DROP-HASH — card number emitted bare, not #-prefixed", () => {
  it("query built for CH does NOT include a `#` prefix on the card number", async () => {
    let capturedQuery: string | undefined;
    vi.mocked(searchCards).mockImplementation(async (q) => {
      capturedQuery = q;
      return [] as any;
    });
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    await suggestCardIdForHolding(makeHolding({
      cardYear: 2026,
      setName: "Bowman Chrome",
      parallel: "Green Refractor",
      cardNumber: "CPA-EH",
    }));
    expect(capturedQuery).toBeDefined();
    // The `#` prefix tanked CH tokenizer relevance — must be gone.
    expect(capturedQuery).not.toContain("#");
    // But the card number itself must still be in the query.
    expect(capturedQuery).toContain("CPA-EH");
  });
});

describe("CF-CARDID-SUGGESTER-FAIR-SCORING — three scorer fixes", () => {
  it("year-from-set-text: candidate.year=null but set='2026 Bowman Baseball' → year matches", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-nullyear",
        set: "2026 Bowman Baseball",          // year in string, not field
        year: null,                             // ← the CH bug this fixes
        number: "CPA-EHA",
        variant: "Green Refractor",
        name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding({
      cardYear: 2026,
      parallel: "Green Refractor",  // exact-match parallel → high tier possible
    }));
    expect(r).not.toBeNull();
    // cardYear should NOT be in mismatched fields — the set-text fallback found 2026.
    expect(r!.matchBreakdown.mismatchedFields).not.toContain("cardYear");
  });

  it("isAuto-from-card-number: CH auto SKU with plain 'Base' variant → isAuto matches", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-auto-via-num",
        set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA",                     // ← CPA prefix = auto
        variant: "Base",                       // ← variant text has no "auto" word
        name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding({ isAuto: true, parallel: null }));
    expect(r).not.toBeNull();
    expect(r!.matchBreakdown.mismatchedFields).not.toContain("isAuto");
  });

  it("player-trust-filter: candidate with null name/title → player check skipped, not mismatched", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-noname",
        set: "2026 Bowman Baseball", year: 2026,
        number: "CPA-EHA", variant: "Green Refractor",
        name: null, title: null,               // ← CH's actual response shape
      } as any,
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding({ parallel: "Green Refractor" }));
    expect(r).not.toBeNull();
    // playerName should NOT be in mismatched fields — candidate has no
    // signal to compare against, so the check is skipped entirely.
    expect(r!.matchBreakdown.mismatchedFields).not.toContain("playerName");
  });

  it("combined: real CH candidate (null year, null name, CPA auto, exact parallel) → HIGH tier", async () => {
    // The exact wire shape CH returns for CPA-EHA cards per the 2026-07-14
    // probe. Pre-fix all these landed at LOW tier (0.45) because three
    // false-mismatch checks (cardYear, playerName, isAuto) each cost weight.
    // Post-fix: 4/4 checkable fields match → HIGH tier.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-real-shape",
        set: "2026 Bowman Baseball", year: null,
        number: "CPA-EHA", variant: "Green Refractor",
        name: null, title: null,
      } as any,
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding({
      parallel: "Green Refractor",
      isAuto: true,
    }));
    expect(r).not.toBeNull();
    expect(r!.confidenceTier).toBe("high");
  });
});

describe("CF-CARDID-SUGGESTER-TOP-N — alternatives surfacing", () => {
  it("HIGH tier suppresses alternatives (primary is confident enough)", async () => {
    // Perfect field alignment → tier=high → NO alternatives on the wire.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-perfect",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Blue Refractor Auto",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Blue Refractor Auto",
        name: "Eric Hartman",
      },
      {
        card_id: "ch-runner-up",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor Auto",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Green Refractor",
        name: "Eric Hartman",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.confidenceTier).toBe("high");
    expect(r!.alternatives).toBeUndefined();
  });

  it("MEDIUM tier emits up to 2 alternatives ranked by score", async () => {
    // Partial alignment (year+player+set match but parallel misses) → medium tier.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-primary",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Green Refractor",
        name: "Eric Hartman",
      },
      {
        card_id: "ch-alt-1",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Purple Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Purple Refractor",
        name: "Eric Hartman",
      },
      {
        card_id: "ch-alt-2",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Speckle Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Speckle Refractor",
        name: "Eric Hartman",
      },
      {
        card_id: "ch-alt-3-should-be-clipped",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Yellow Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Yellow Refractor",
        name: "Eric Hartman",
      },
    ]);
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([]);
    // Force MEDIUM tier by giving the holding a year that mismatches all
    // candidates — post fair-scoring fix the primary would otherwise
    // land in the high tier on 5/6 field alignment.
    const r = await suggestCardIdForHolding(makeHolding({ cardYear: 2025 }));
    expect(r!.confidenceTier).not.toBe("high");
    expect(r!.alternatives).toBeDefined();
    // Cap at 2, primary excluded, in score order.
    expect(r!.alternatives!.length).toBeLessThanOrEqual(2);
    const altIds = r!.alternatives!.map((a) => a.cardId);
    expect(altIds).not.toContain("ch-primary");
    expect(altIds).not.toContain("ch-alt-3-should-be-clipped");
  });

  it("CROSS-VENDOR dedup: CH + CS rows for the same (year, number, parallel) surface once", async () => {
    // Holding year is 2025 while candidates are 2026 — creates a year
    // mismatch on every candidate so primary lands in medium tier, which
    // means alternatives DO get emitted (tier=high suppresses them).
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-primary",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Green Refractor",
        name: "Eric Hartman",
      },
      {
        card_id: "ch-alt-cand",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Speckle Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Speckle Refractor",
        name: "Eric Hartman",
      },
    ]);
    // CS returns the SAME physical Speckle Refractor SKU — should be
    // deduped OUT of alternatives (dedup key year::number::parallel).
    vi.mocked(fetchCardsightUuidNativeCandidates).mockResolvedValue([
      csRow({
        candidateId: "cardsight:00000000-0000-0000-0000-000000000010::00000000-0000-0000-0000-000000000011",
        year: 2026,
        parallel: "Speckle Refractor",
      }),
    ]);
    const r = await suggestCardIdForHolding(
      // cardYear=2025 forces medium tier on every candidate; parallel Green
      // Refractor keeps CH primary winning by parallel-match tiebreak.
      makeHolding({ parallel: "Green Refractor", cardYear: 2025 }),
    );
    expect(r!.candidateSource).toBe("cardhedge");
    expect(r!.cardId).toBe("ch-primary");
    expect(r!.confidenceTier).not.toBe("high");
    // ch-alt-cand should be there; CS Speckle Refractor deduped OUT.
    const altIds = (r!.alternatives ?? []).map((a) => a.cardId);
    expect(altIds).toContain("ch-alt-cand");
    expect(altIds).not.toContain(
      "00000000-0000-0000-0000-000000000010::00000000-0000-0000-0000-000000000011",
    );
  });

  it("alternatives min-score gate filters trivially-low candidates", async () => {
    // Same year-mismatch trick to force medium tier + emit alternatives.
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-primary",
        title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
        set: "Bowman Chrome", year: 2026, number: "CPA-EHA", variant: "Green Refractor",
        name: "Eric Hartman",
      },
      // Zero-field match — everything wrong.
      {
        card_id: "ch-junk",
        title: "unrelated card",
        set: "Other Set", year: 1990, number: "999", variant: "Base",
        name: "Someone Else",
      },
    ]);
    const r = await suggestCardIdForHolding(
      makeHolding({ parallel: "Green Refractor", cardYear: 2025 }),
    );
    // Even if there's room in the alternatives array, low-score junk
    // shouldn't show up.
    const altIds = (r!.alternatives ?? []).map((a) => a.cardId);
    expect(altIds).not.toContain("ch-junk");
  });
});
