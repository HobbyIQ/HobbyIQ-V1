/**
 * CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01) tests.
 *
 * Covers the three load-bearing pieces of the combined ②+① CF:
 *
 *   ② RE-RESOLVE: when scored top candidate's card-number auto-prefix
 *     disagrees with input.isAuto AND a corrected same-auto-side
 *     candidate exists in the scored pool, swap to the corrected
 *     candidate. Tested against the 3 production headline cards
 *     (Bonemer, Tommy White, Gage Wood) to confirm comps come from the
 *     RIGHT auto-ness card.
 *
 *   ① TOKENIZATION (contiguous-prefix + shorter-name preference):
 *     "gold" → "Gold Refractor" (not "Gold Wave Refractor" or "Shimmer
 *     Gold Refractor"); "mini diamond" → "MIni-Diamond Refractor"
 *     (hyphen↔space + case-fold).
 *
 *   ③ GUARD HARDENING: when re-resolve cannot find a corrected
 *     candidate, the loose matcher is DISABLED (allowLoose=false), so
 *     the strict matcher's miss propagates as "returning cardId only"
 *     → downstream Q8'' guard still fires.
 *
 * Tests run against mocked cardsight.client per the existing
 * cardsight.mapper.test.ts pattern. The Q8'' integration is tested
 * separately by compiqEstimate.q8refinement.test.ts (which mocks
 * findCompsRouted directly and bypasses this layer).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", () => ({
  searchCatalog: vi.fn(),
  getCardDetail: vi.fn(),
  getPricing: vi.fn(),
}));

import * as cs from "../src/services/compiq/cardsight.client.js";
import {
  resolveCardId,
  __resolveCardIdInternals,
} from "../src/services/compiq/cardsight.mapper";

type Catalog = Awaited<ReturnType<typeof cs.searchCatalog>>[number];
type Detail = Awaited<ReturnType<typeof cs.getCardDetail>>;
type Pricing = Awaited<ReturnType<typeof cs.getPricing>>;

function catalogEntry(
  id: string,
  number: string,
  releaseName: string,
  setName = "Base Set",
  year = 2024,
): Catalog {
  return { id, name: "x", number, releaseName, setName, year };
}

function detailWithParallels(
  id: string,
  number: string,
  parallelNames: string[],
  releaseName = "Bowman Draft",
): Detail {
  return {
    id,
    name: "x",
    number,
    releaseName,
    setName: "Chrome Prospects",
    year: 2024,
    parallels: parallelNames.map((name, i) => ({
      id: `${id}-parallel-${i}-${name.toLowerCase().replace(/[\s\-/]+/g, "-")}`,
      name,
    })),
  };
}

function pricing(totalRecords: number): Pricing {
  return {
    raw: { count: totalRecords, records: [] },
    graded: [],
    meta: { total_records: totalRecords, last_sale_date: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resolveCardIdInternals.clearCache();
});

// ────────────────────────────────────────────────────────────────────────────
// ② RE-RESOLVE — 3 production headline cards
// ────────────────────────────────────────────────────────────────────────────

describe("② RE-RESOLVE — auto-prefix correction picks the RIGHT card", () => {
  it("Bonemer (user wants BASE Gold, scored picks AUTO CPA-CBO) → re-resolves to BASE BD-CBO", async () => {
    // Catalog returns the AUTO base prefix card first (Cardsight's ranking
    // priors), but the BASE prospect card is also present in the candidate
    // pool. With user.isAuto=false, the re-resolve guard must swap to the
    // base candidate.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("cpa-cbo-id", "CPA-CBO", "Bowman Draft", "Chrome Prospect Autographs"),
      catalogEntry("bd-cbo-id", "BD-CBO", "Bowman Draft", "Chrome Prospects"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "cpa-cbo-id": 78, "bd-cbo-id": 50 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockImplementation((id: string) =>
      Promise.resolve(
        id === "bd-cbo-id"
          ? detailWithParallels("bd-cbo-id", "BD-CBO", [
              "Refractor",
              "Gold Refractor",
              "Blue Refractor",
            ])
          : detailWithParallels("cpa-cbo-id", "CPA-CBO", [
              "Refractor",
              "Gold Refractor",
              "Gold Wave Refractor",
              "Shimmer Gold Refractor",
            ]),
      ),
    );

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Comps must come from the BASE card, not the AUTO.
    expect(r.cardId).toBe("bd-cbo-id");
    expect(r.parallelId).toBe("bd-cbo-id-parallel-1-gold-refractor");
    // Re-resolve warning surfaces in the warnings list.
    expect(r.warnings.some((w) =>
      w.includes("auto-prefix corrected") && w.includes("BD-CBO")
    )).toBe(true);
  });

  it("Tommy White (user wants AUTO Mini-Diamond, scored picks BASE BCP-251) → re-resolves to AUTO CPA-251", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("bcp-251-id", "BCP-251", "Bowman Chrome", "Prospects", 2025),
      catalogEntry("cpa-251-id", "CPA-251", "Bowman Chrome", "Prospect Autographs", 2025),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "bcp-251-id": 118, "cpa-251-id": 22 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockImplementation((id: string) =>
      Promise.resolve(
        id === "cpa-251-id"
          ? detailWithParallels("cpa-251-id", "CPA-251", [
              "Refractor",
              "MIni-Diamond Refractor",
              "Gold Refractor",
            ], "Bowman Chrome")
          : detailWithParallels("bcp-251-id", "BCP-251", [
              "Refractor",
              "MIni-Diamond Refractor",
              "Blue Refractor",
              "Gold Refractor",
              "Orange Refractor",
            ], "Bowman Chrome"),
      ),
    );

    const r = await resolveCardId({
      playerName: "Tommy White",
      cardYear: 2025,
      product: "Bowman Chrome",
      parallel: "mini diamond",
      isAuto: true,
    });

    expect(r.cardId).toBe("cpa-251-id");
    // The hyphen+space + case-fold normalization binds the loose-prefix
    // match to MIni-Diamond Refractor on the AUTO card.
    expect(r.parallelId).toBe("cpa-251-id-parallel-1-mini-diamond-refractor");
    expect(r.warnings.some((w) =>
      w.includes("auto-prefix corrected") && w.includes("CPA-251")
    )).toBe(true);
  });

  it("Gage Wood (user wants AUTO Gold, scored picks BASE BDC-4) → re-resolves to AUTO CPA-GW", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("bdc-4-id", "BDC-4", "Bowman Draft", "Chrome", 2025),
      catalogEntry("cpa-gw-id", "CPA-GW", "Bowman Draft", "Chrome Auto", 2025),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "bdc-4-id": 122, "cpa-gw-id": 15 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockImplementation((id: string) =>
      Promise.resolve(
        id === "cpa-gw-id"
          ? detailWithParallels("cpa-gw-id", "CPA-GW", [
              "Refractor",
              "Gold Refractor",
              "Blue Refractor",
            ], "Bowman Draft")
          : detailWithParallels("bdc-4-id", "BDC-4", [
              "Refractor",
              "Gold Refractor",
              "Gold Mojo Refractor",
              "Blue Refractor",
            ], "Bowman Draft"),
      ),
    );

    const r = await resolveCardId({
      playerName: "Gage Wood",
      cardYear: 2025,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: true,
    });

    expect(r.cardId).toBe("cpa-gw-id");
    expect(r.parallelId).toBe("cpa-gw-id-parallel-1-gold-refractor");
    expect(r.warnings.some((w) =>
      w.includes("auto-prefix corrected") && w.includes("CPA-GW")
    )).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ① TOKENIZATION — loose contiguous-prefix + shorter-name preference
// ────────────────────────────────────────────────────────────────────────────

describe("① TOKENIZATION — loose contiguous-prefix match with shortest-name preference", () => {
  it('"gold" binds to "Gold Refractor" when no exact-match parallel exists', async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("only-id", "BD-X", "Bowman Draft"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "BD-X", [
        "Refractor",
        "Gold Refractor",
        "Blue Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    expect(r.cardId).toBe("only-id");
    expect(r.parallelId).toBe("only-id-parallel-1-gold-refractor");
  });

  it('shorter-name preference: "gold" picks "Gold Refractor" over "Gold Wave Refractor" / "Shimmer Gold Refractor"', async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("only-id", "BD-X", "Bowman Draft"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "BD-X", [
        "Shimmer Gold Refractor",
        "Gold Wave Refractor",
        "Gold Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Of three loose prefix-matches:
    //   "Gold Refractor"          tokens=2  ← winner (shortest)
    //   "Gold Wave Refractor"     tokens=3
    //   "Shimmer Gold Refractor"  fails prefix-match (catalog tokens[0]="shimmer")
    expect(r.parallelId).toBe("only-id-parallel-2-gold-refractor");
  });

  it('hyphen + space + case-fold: "mini diamond" matches "MIni-Diamond Refractor"', async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("only-id", "BD-X", "Bowman Chrome"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "BD-X", [
        "Refractor",
        "MIni-Diamond Refractor",
        "Geometric Refractor",
      ], "Bowman Chrome"),
    );

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2025,
      product: "Bowman Chrome",
      parallel: "mini diamond",
      isAuto: false,
    });

    expect(r.parallelId).toBe("only-id-parallel-1-mini-diamond-refractor");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ③ GUARD HARDENING — re-resolve-failed case still skips
// ────────────────────────────────────────────────────────────────────────────

describe("③ GUARD HARDENING — when re-resolve can't correct the auto/base mismatch, loose matcher is DISABLED", () => {
  it("Bonemer-style with NO base alternative in pool → parallelId stays null + parallelNotFound warning emitted (Q8'' guard preserved)", async () => {
    // Only the AUTO base card exists in the candidate pool. The
    // re-resolve guard can't find a base-side alternative, so it
    // forces allowLooseParallelMatch=false. The strict matcher then
    // fails ("gold" != ["gold","refractor"]) and the
    // "returning cardId only" warning is emitted — which the Q8''
    // guard at compiqEstimate.service.ts:1937 reads to skip the
    // tier ladder. THIS IS THE LOAD-BEARING TEST that proves ①
    // alone-ship would have regressed this case.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("cpa-only-id", "CPA-CBO", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("cpa-only-id", "CPA-CBO", [
        "Refractor",
        "Gold Refractor",
        "Blue Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Card unchanged (no alternative existed); parallelId NOT bound to
    // CPA-CBO's "Gold Refractor" because allowLoose=false; warning emitted.
    expect(r.cardId).toBe("cpa-only-id");
    expect(r.parallelId).toBeNull();
    expect(r.warnings.some((w) =>
      w.includes("returning cardId only") && w.includes("Gold")
    )).toBe(true);
    // The re-resolve-success warning must NOT be in the list (re-resolve
    // didn't succeed; it failed and forced strict-only).
    expect(r.warnings.some((w) => w.includes("auto-prefix corrected"))).toBe(false);
  });

  it("auto/base match: when chosen card's auto-prefix MATCHES input.isAuto, loose matcher stays ENABLED (Bonemer auto + Gold)", async () => {
    // User asked for AUTO + Gold; the resolver landed on CPA-CBO which
    // IS auto. allowLoose=true → loose prefix-match binds "gold" →
    // "Gold Refractor". No re-resolve needed; matcher loosens; no
    // parallelNotFound warning.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("cpa-only-id", "CPA-CBO", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("cpa-only-id", "CPA-CBO", [
        "Refractor",
        "Gold Refractor",
        "Gold Wave Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: true,
    });

    expect(r.cardId).toBe("cpa-only-id");
    expect(r.parallelId).toBe("cpa-only-id-parallel-1-gold-refractor");
    expect(r.warnings.some((w) => w.includes("returning cardId only"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SAFETY — no false matches; sales-sparsity unaffected
// ────────────────────────────────────────────────────────────────────────────

describe("SAFETY — no false matches + sales-sparsity unaffected", () => {
  it("genuinely-absent parallel: user 'Aqua' on a card with no Aqua-prefixed parallel → parallelNotFound (no false bind)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("only-id", "BD-X", "Bowman Draft"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "BD-X", [
        "Refractor",
        "Black Refractor",
        "Blue Refractor",
        "Gold Refractor",
        // No "Aqua Refractor" in this card's parallels.
      ]),
    );

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Aqua",
      isAuto: false,
    });

    expect(r.cardId).toBe("only-id");
    expect(r.parallelId).toBeNull();
    expect(r.warnings.some((w) =>
      w.includes("returning cardId only") && w.includes("Aqua")
    )).toBe(true);
  });

  it('defect-#2 spirit preserved by PREFIX semantics: "Wave" does NOT bind to "Blue Wave Refractor" (catalog tokens[0]="blue")', async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("only-id", "BD-X", "Bowman Draft"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "BD-X", [
        "Refractor",
        "Blue Wave Refractor",
        "Orange Wave Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Wave",
      isAuto: false,
    });

    // "wave" is a SUFFIX/INFIX of these parallels, not a PREFIX. Loose
    // matcher rejects all → no bind → parallel_not_found.
    expect(r.parallelId).toBeNull();
    expect(r.warnings.some((w) => w.includes("returning cardId only"))).toBe(true);
  });

  it("sales-sparsity case (47% bucket): parallel binds, sparse-comps fate is downstream — resolver itself unaffected", async () => {
    // Models the breadth probe's "no-recent-comps" bucket: resolver
    // correctly identifies BD-X with a Blue Refractor parallel, binds
    // the parallel via strict match; the eventual 0-comp outcome is a
    // downstream concern (pricing layer), not resolveCardId's.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("base-prospect-id", "BCP-26", "Bowman Chrome", "Prospects"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("base-prospect-id", "BCP-26", [
        "Refractor",
        "Blue Refractor",
        "Gold Refractor",
        "Orange Refractor",
      ], "Bowman Chrome"),
    );

    const r = await resolveCardId({
      playerName: "Jackson Holliday",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: false,
    });

    // Strict match (exact equality) binds before the loose path fires.
    expect(r.cardId).toBe("base-prospect-id");
    expect(r.parallelId).toBe("base-prospect-id-parallel-1-blue-refractor");
    // No re-resolve warnings; no parallelNotFound warnings; cache is
    // populated normally. The downstream getPricing returning 0 sales
    // for the PSA-10 Blue Refractor slice is unrelated to anything in
    // resolveCardId — this CF doesn't touch sales-sparsity behavior.
    expect(r.warnings.some((w) => w.includes("auto-prefix"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("returning cardId only"))).toBe(false);
  });
});
