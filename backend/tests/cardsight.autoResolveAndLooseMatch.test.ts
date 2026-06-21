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

/**
 * CF-69-FINISH: module-level mutable for the current test's input
 * playerName. catalogEntry / catalogEntryLite default `name` to this so
 * candidates pass the legacy name-guard (CF-69-FINISH 2+ token gate)
 * without per-call boilerplate. Each multi-token test sets `_testPlayer`
 * at its top; `beforeEach` resets to "x" for single-token tests (where
 * the gate is inert and the placeholder is fine).
 */
let _testPlayer = "x";

function catalogEntry(
  id: string,
  number: string,
  releaseName: string,
  setName = "Base Set",
  year = 2024,
  name?: string,
): Catalog {
  return { id, name: name ?? _testPlayer, number, releaseName, setName, year };
}

/**
 * CF-CARDSIGHT-CATALOG-NUMBER-PROBE (2026-06-01): models the production
 * lite-record condition where Cardsight's /catalog/search returns
 * candidates with empty `number` (SKU only materializes after
 * getCardDetail or getPricing). The Bonemer Gold class that escaped
 * the prior CF's tests — production-observed 2026-06-01 03:22Z where
 * `applyAutoPrefixGuard` silently no-op'd because chosen.number=""
 * → isAutoPrefix("")=false → matched user's isAuto=false → guard
 * skipped → loose matcher bound Gold Refractor on the wrong-auto card.
 */
function catalogEntryLite(
  id: string,
  releaseName: string,
  setName = "Base Set",
  year = 2024,
  name?: string,
): Catalog {
  return { id, name: name ?? _testPlayer, number: "", releaseName, setName, year };
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
  // CF-69-FINISH: reset _testPlayer to placeholder. Multi-token tests
  // override at their top; single-token tests leave it (legacy name-guard
  // 2+ token gate skips them).
  _testPlayer = "x";
});

// ────────────────────────────────────────────────────────────────────────────
// ② RE-RESOLVE — 3 production headline cards
// ────────────────────────────────────────────────────────────────────────────

describe("② RE-RESOLVE — auto-prefix correction picks the RIGHT card", () => {
  it("Bonemer (user wants BASE Gold, scored picks AUTO CPA-CBO) → re-resolves to BASE BD-CBO", async () => {
    _testPlayer = "Caleb Bonemer";
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
    _testPlayer = "Tommy White";
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
    _testPlayer = "Gage Wood";
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
    _testPlayer = "Some Player";
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
    _testPlayer = "Some Player";
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
    _testPlayer = "Some Player";
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
    _testPlayer = "Caleb Bonemer";
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
    _testPlayer = "Caleb Bonemer";
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
    _testPlayer = "Some Player";
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
    _testPlayer = "Some Player";
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
    _testPlayer = "Jackson Holliday";
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

// ────────────────────────────────────────────────────────────────────────────
// CF-CARDSIGHT-CATALOG-NUMBER-PROBE — the lite-record condition that
// escaped the prior CF (Bonemer Gold class observed in production
// 2026-06-01 03:22Z: searchCatalog returns chosen.number="",
// isAutoPrefix("")=false, matched user.isAuto=false, guard silently
// no-op'd, loose matcher bound on wrong-auto card).
// ────────────────────────────────────────────────────────────────────────────

describe("CATALOG-NUMBER-PROBE — gated detail probe for lite-record searchCatalog results", () => {
  it("Bonemer-class repro: searchCatalog number='' + getCardDetail populates 'CPA-CBO' → probe fires → mismatch detected → no pool correction → allowLoose=false → parallelId null", async () => {
    _testPlayer = "Caleb Bonemer";
    // 2 candidates, BOTH returned as lite records (number="") from
    // searchCatalog. Both have pricing data → pool.length>1 → probe
    // condition satisfied. Detail probe populates SKU for chosen only;
    // the OTHER pool candidate stays lite (number="") and is therefore
    // EXCLUDED from the corrected-search per the defensive narrowing.
    // Net effect: guard correctly detects auto-prefix-mismatch via the
    // probed SKU, finds no corrected candidate, sets allowLoose=false.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntryLite("cpa-cbo-id", "Bowman Draft", "Chrome Prospect Autographs"),
      catalogEntryLite("cpa-cbo-alt", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "cpa-cbo-id": 78, "cpa-cbo-alt": 56 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockImplementation((id: string) => {
      if (id === "cpa-cbo-id") {
        // Probe call: returns CPA-CBO (auto SKU). detail.parallels[]
        // also populated here for the later resolveParallelOnCandidate
        // call (single source — both consumers read the same detail).
        return Promise.resolve(
          detailWithParallels("cpa-cbo-id", "CPA-CBO", [
            "Refractor",
            "Gold Refractor",
            "Blue Refractor",
          ]),
        );
      }
      return Promise.resolve(detailWithParallels(id, "", []));
    });

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Card stays at the wrong-auto chosen (no corrected in pool);
    // parallelId NOT bound to CPA-CBO's "Gold Refractor" because the
    // probe-then-guard sets allowLoose=false.
    expect(r.cardId).toBe("cpa-cbo-id");
    expect(r.parallelId).toBeNull();
    expect(r.warnings.some((w) =>
      w.includes("returning cardId only") && w.includes("Gold")
    )).toBe(true);
    expect(r.warnings.some((w) => w.includes("auto-prefix corrected"))).toBe(false);

    // Load-bearing diagnostic: probe MUST have fired. getCardDetail is
    // called both for the probe AND for resolveParallelOnCandidate's
    // parallels lookup → expect ≥1 call. The probe + parallels call
    // can share the same cache entry (DETAIL_TTL_SEC=24h), so this is
    // a lower-bound assertion not an exact count.
    expect((cs.getCardDetail as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    // Verify the probe targeted the chosen cardId specifically.
    const probedIds = (cs.getCardDetail as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(probedIds).toContain("cpa-cbo-id");
  });

  it("probe-skip when chosen.number already populated: guard runs synchronously on the search-time SKU; no extra getCardDetail call for the probe", async () => {
    _testPlayer = "Caleb Bonemer";
    // Single candidate with SKU populated from searchCatalog — the fast
    // path. The probe gate (chosen.number==="") is NOT met → no probe.
    // resolveParallelOnCandidate will call getCardDetail ONCE for the
    // parallels lookup; that's the only detail call expected.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntry("cpa-cbo-id", "CPA-CBO", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("cpa-cbo-id", "CPA-CBO", [
        "Refractor",
        "Gold Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: true,
    });

    // SKU match → guard no-ops → loose match binds Gold Refractor.
    expect(r.cardId).toBe("cpa-cbo-id");
    expect(r.parallelId).toBe("cpa-cbo-id-parallel-1-gold-refractor");
    // Exactly ONE getCardDetail call (the resolveParallelOnCandidate
    // parallels lookup). NOT TWO — the probe did NOT fire because
    // chosen.number was already populated.
    expect((cs.getCardDetail as any).mock.calls.length).toBe(1);
  });

  it("probe-skip when input.isAuto is undefined: guard short-circuits at the input check, no probe even on lite record", async () => {
    _testPlayer = "Caleb Bonemer";
    // Legacy caller (no isAuto signal) → guard returns immediately at
    // the input.isAuto===undefined gate → no probe, regardless of
    // chosen.number being empty.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntryLite("cpa-cbo-id", "Bowman Draft", "Chrome Prospect Autographs"),
      catalogEntryLite("cpa-cbo-alt", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "cpa-cbo-id": 78, "cpa-cbo-alt": 56 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("cpa-cbo-id", "CPA-CBO", [
        "Refractor",
        "Gold Refractor",
      ]),
    );

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      // NO isAuto field.
    });

    // Loose match still fires (guard skipped, allowLoose stays true).
    expect(r.cardId).toBe("cpa-cbo-id");
    expect(r.parallelId).toBe("cpa-cbo-id-parallel-1-gold-refractor");
    // getCardDetail called for parallels lookup ONLY (1 call total).
    // The probe didn't fire because input.isAuto was undefined.
    expect((cs.getCardDetail as any).mock.calls.length).toBe(1);
  });

  it("probe-skip when pool.length === 1: probe gate requires pool.length > 1 (swap is impossible with one candidate)", async () => {
    _testPlayer = "Some Player";
    // Single-candidate path (Step B). pool=[] at the guard call site.
    // Probe gate `pool.length > 1` not met → no probe. allowLoose
    // depends on isAutoPrefix(""), which is false. input.isAuto=false
    // matches chosenIsAuto=false → guard no-ops → allowLoose=true.
    // Loose matcher binds Gold Refractor.
    // (This is the established behavior for single-candidate lite
    // records — documented limitation, NOT a regression. The pool-depth
    // CF would address it by widening the candidate pool before the
    // single-candidate fast path fires.)
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntryLite("only-id", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(
      detailWithParallels("only-id", "CPA-XYZ", [
        "Refractor",
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

    // Guard no-op'd (probe skipped + no isAutoPrefix mismatch detected
    // because chosenNumber stays ""). Loose match binds. Documented
    // limitation — single-candidate path doesn't trigger probe.
    expect(r.cardId).toBe("only-id");
    expect(r.parallelId).toBe("only-id-parallel-1-gold-refractor");
    expect((cs.getCardDetail as any).mock.calls.length).toBe(1);
  });

  it("probe failure (notFound): defensive allowLoose=false fallback locks the safe path", async () => {
    _testPlayer = "Caleb Bonemer";
    // Probe fires but Cardsight detail returns notFound (e.g. cardId
    // exists in catalog index but detail endpoint 404s). We can't
    // verify auto-ness → treat as uncorrectable mismatch.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntryLite("cpa-cbo-id", "Bowman Draft", "Chrome Prospect Autographs"),
      catalogEntryLite("cpa-cbo-alt", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "cpa-cbo-id": 78, "cpa-cbo-alt": 56 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockResolvedValue({
      id: "cpa-cbo-id",
      name: "",
      number: "",
      releaseName: "",
      setName: "",
      year: 0,
      parallels: [],
      attributes: [],
      notFound: true,
    });

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Probe failed → guard set allowLoose=false → no loose match → no
    // strict match either (detail.parallels[] is empty in notFound
    // detail) → parallelId null.
    expect(r.parallelId).toBeNull();
  });

  it("probe returns ALSO-empty number: defensive allowLoose=false (degraded-but-safe path)", async () => {
    _testPlayer = "Caleb Bonemer";
    // Cardsight detail endpoint exists for this cardId but returns
    // a record where the `number` field is also empty (Cardsight has
    // catalog records that are not fully populated). Probe can't get
    // the SKU from detail either → defensive default.
    (cs.searchCatalog as any).mockResolvedValue([
      catalogEntryLite("cpa-cbo-id", "Bowman Draft", "Chrome Prospect Autographs"),
      catalogEntryLite("cpa-cbo-alt", "Bowman Draft", "Chrome Prospect Autographs"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "cpa-cbo-id": 78, "cpa-cbo-alt": 56 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });
    (cs.getCardDetail as any).mockImplementation((id: string) => {
      if (id === "cpa-cbo-id") {
        // Detail exists (not notFound) but number is empty.
        return Promise.resolve({
          id: "cpa-cbo-id",
          name: "Caleb Bonemer",
          number: "",          // ← THE FAILURE MODE
          releaseName: "Bowman Draft",
          setName: "Chrome Prospect Autographs",
          year: 2024,
          parallels: [
            { id: "p1", name: "Refractor" },
            { id: "p2", name: "Gold Refractor" },
          ],
          attributes: [],
        });
      }
      return Promise.resolve(detailWithParallels(id, "", []));
    });

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft",
      parallel: "Gold",
      isAuto: false,
    });

    // Probe succeeded structurally but couldn't recover the SKU →
    // allowLoose=false → strict-only match on Gold (length 1) misses
    // Gold Refractor (length 2) → parallelId null + warning emitted.
    expect(r.parallelId).toBeNull();
    expect(r.warnings.some((w) =>
      w.includes("returning cardId only") && w.includes("Gold")
    )).toBe(true);
  });
});
