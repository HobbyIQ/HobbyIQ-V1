/**
 * CF-69-RESOLVER-FIX (2026-06-21) tests.
 *
 * Covers the 2-shape catalog retry + post-fetch filter pipeline for the
 * hot RC class. The legacy single-shape `{playerName} {releaseName}`
 * pipeline mis-ranked Topps Heritage above Topps Chrome (substring
 * "Topps" matched both) and collided same-surname players (Ronald Acuna
 * Jr ↔ Luisangel Acuna). CF-69 replaces it with:
 *
 *   Shape Y primary: `{year} {releaseName} {playerName} RC` (no year=
 *     filter — empirically flaky on Skenes-class cards per CF-69 C2)
 *   Filter chain: exact-release → year → name-guard → setName-canonical
 *     (cascade to looser non-empty set when each tighter filter empties)
 *   Shape S fallback: `{surname} {releaseName}` — fires only when
 *     Shape Y empties post-filter
 *   Legacy fallback: original single-shape + substring release filter
 *     (back-compat for non-flagship queries)
 *
 * Test groups:
 *   - Helper unit tests (one per exported helper, with edge cases)
 *   - Integration tests via _resolveCardId for the four hot-RC scenarios
 *     (Skenes, Judge, Ohtani, Acuña)
 *   - Back-compat regression (non-flagship query → legacy path)
 *   - Judge MVP-Buyback case (setName preference picks canonical base)
 *
 * Mocks follow the existing cardsight.mapper.test.ts pattern.
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
  buildShapeYQuery,
  buildShapeSQuery,
  filterExactRelease,
  isCanonicalSetName,
  filterByYearMatch,
  passesNameGuard,
} from "../src/services/compiq/cardsight.mapper";
import type { CardsightCatalogResult } from "../src/services/compiq/cardsight.client.js";

type Pricing = Awaited<ReturnType<typeof cs.getPricing>>;

function cand(
  id: string,
  releaseName: string,
  setName: string,
  year: number | string,
  name: string,
  number = "",
): CardsightCatalogResult {
  return {
    id,
    name,
    number,
    releaseName,
    setName,
    year: year as number,
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

// ───── Helper unit tests ─────────────────────────────────────────────────────

describe("buildShapeYQuery", () => {
  it("builds canonical Shape Y for full hot-RC inputs", () => {
    expect(buildShapeYQuery(2024, "Topps Chrome", "Paul Skenes"))
      .toBe("2024 Topps Chrome Paul Skenes RC");
  });

  it("handles numeric year passed as string (cardYear can be either type)", () => {
    expect(buildShapeYQuery("2017", "Topps Chrome", "Aaron Judge"))
      .toBe("2017 Topps Chrome Aaron Judge RC");
  });

  it("omits year token when cardYear is undefined", () => {
    expect(buildShapeYQuery(undefined, "Topps Chrome", "Paul Skenes"))
      .toBe("Topps Chrome Paul Skenes RC");
  });

  it("returns null when releaseName is null (forces caller to skip Shape Y)", () => {
    expect(buildShapeYQuery(2024, null, "Paul Skenes")).toBeNull();
  });

  it("returns null when playerName is empty", () => {
    expect(buildShapeYQuery(2024, "Topps Chrome", "")).toBeNull();
    expect(buildShapeYQuery(2024, "Topps Chrome", "   ")).toBeNull();
  });

  it("trims whitespace on playerName", () => {
    expect(buildShapeYQuery(2024, "Topps Chrome", "  Paul Skenes  "))
      .toBe("2024 Topps Chrome Paul Skenes RC");
  });
});

describe("buildShapeSQuery", () => {
  it("uses surname when playerName is two tokens", () => {
    expect(buildShapeSQuery("Topps Chrome", "Paul Skenes"))
      .toBe("Skenes Topps Chrome");
  });

  it("uses single token when playerName is one token", () => {
    expect(buildShapeSQuery("Topps Chrome", "Skenes"))
      .toBe("Skenes Topps Chrome");
  });

  it("strips trailing generational Jr suffix — 'Ronald Acuna Jr' → surname 'Acuna'", () => {
    // Without strip, surname would be "Jr" → query "Jr Topps Chrome" which
    // Cardsight fuzzy-matches globally (same false-positive class as
    // Heritage-substring-above-Chrome). The strip recovers the real surname.
    expect(buildShapeSQuery("Topps Chrome", "Ronald Acuna Jr"))
      .toBe("Acuna Topps Chrome");
  });

  it("strips trailing Jr. (with period)", () => {
    expect(buildShapeSQuery("Topps Chrome", "Cal Ripken Jr."))
      .toBe("Ripken Topps Chrome");
  });

  it("strips trailing Sr (case-insensitive)", () => {
    expect(buildShapeSQuery("Topps Chrome", "Ken Griffey Sr"))
      .toBe("Griffey Topps Chrome");
    expect(buildShapeSQuery("Topps Chrome", "Ken Griffey SR."))
      .toBe("Griffey Topps Chrome");
  });

  it("strips trailing roman-numeral generational suffixes (II, III, IV)", () => {
    expect(buildShapeSQuery("Topps Chrome", "Steve Garvey II"))
      .toBe("Garvey Topps Chrome");
    expect(buildShapeSQuery("Topps Chrome", "Cecil Fielder III"))
      .toBe("Fielder Topps Chrome");
    expect(buildShapeSQuery("Topps Chrome", "Player IV"))
      .toBe("Player Topps Chrome");
  });

  it("strips multiple trailing generational suffixes if present (defensive)", () => {
    // Unlikely in practice (no one is "Jr Sr" or "II III") but the strip
    // loop guards against degenerate parser output.
    expect(buildShapeSQuery("Topps Chrome", "Player Name Jr Sr"))
      .toBe("Name Topps Chrome");
  });

  it("preserves the suffix when the player name is JUST a suffix (degenerate, no real surname to recover)", () => {
    // If somehow playerName comes in as just "Jr", the strip loop terminates
    // at index 0 and keeps "Jr". Caller upstream shouldn't construct this,
    // but we don't crash.
    expect(buildShapeSQuery("Topps Chrome", "Jr"))
      .toBe("Jr Topps Chrome");
  });

  it("does NOT strip suffix-like tokens embedded in the surname (Iverson is not a suffix)", () => {
    // "Iverson" doesn't match the exact-suffix regex (must be just "ii"/"iii"/"iv"
    // optionally with period) — protects against false-strip on real surnames.
    expect(buildShapeSQuery("Topps Chrome", "Allen Iverson"))
      .toBe("Iverson Topps Chrome");
  });

  it("returns null when releaseName is null", () => {
    expect(buildShapeSQuery(null, "Paul Skenes")).toBeNull();
  });

  it("returns null when playerName is empty / whitespace", () => {
    expect(buildShapeSQuery("Topps Chrome", "")).toBeNull();
    expect(buildShapeSQuery("Topps Chrome", "   ")).toBeNull();
  });
});

describe("filterExactRelease", () => {
  it("keeps only candidates whose releaseName matches case-insensitively", () => {
    const cands = [
      cand("a", "Topps Chrome", "Base Set", 2024, "Paul Skenes"),
      cand("b", "Topps Heritage", "Base Set", 2024, "Paul Skenes"),
      cand("c", "topps chrome", "Base Set", 2024, "Paul Skenes"),
    ];
    const out = filterExactRelease(cands, "Topps Chrome");
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("rejects substring matches that the legacy substring filter accepted (Heritage above Chrome)", () => {
    // The CF-69 core regression: legacy `.includes()` would accept Heritage
    // when expectedRelease = "Topps Chrome" because Heritage's releaseName
    // contains "Topps". CF-69's exact-match rejects it.
    const cands = [
      cand("heritage", "Topps Heritage", "Base Set", 2017, "Aaron Judge"),
    ];
    expect(filterExactRelease(cands, "Topps Chrome")).toEqual([]);
  });

  it("returns input unchanged when expectedRelease is empty (degenerate guard)", () => {
    const cands = [cand("a", "Topps Chrome", "Base Set", 2024, "Paul Skenes")];
    expect(filterExactRelease(cands, "")).toEqual(cands);
    expect(filterExactRelease(cands, "   ")).toEqual(cands);
  });

  it("treats missing releaseName as non-match", () => {
    const cands = [
      { id: "z", name: "x", number: "", releaseName: "" as any, setName: "", year: 2024 },
    ] as CardsightCatalogResult[];
    expect(filterExactRelease(cands, "Topps Chrome")).toEqual([]);
  });
});

describe("isCanonicalSetName", () => {
  it("matches the canonical base patterns", () => {
    expect(isCanonicalSetName("Base Set")).toBe(true);
    expect(isCanonicalSetName("base set")).toBe(true);
    expect(isCanonicalSetName("Base")).toBe(true);
    expect(isCanonicalSetName("Rookie Cup")).toBe(true);
  });

  it("rejects autograph / relic / dual / insert variants", () => {
    expect(isCanonicalSetName("Autograph")).toBe(false);
    expect(isCanonicalSetName("Refractor")).toBe(false);
    expect(isCanonicalSetName("Chrome Prospect Autograph")).toBe(false);
    expect(isCanonicalSetName("Refractor MVP Buybacks")).toBe(false);
    expect(isCanonicalSetName("Freshman Flash")).toBe(false);
    expect(isCanonicalSetName("All-Etch")).toBe(false);
  });

  it("handles empty / null / undefined", () => {
    expect(isCanonicalSetName(null)).toBe(false);
    expect(isCanonicalSetName(undefined)).toBe(false);
    expect(isCanonicalSetName("")).toBe(false);
    expect(isCanonicalSetName("   ")).toBe(false);
  });
});

describe("filterByYearMatch", () => {
  it("matches by string-compared year (CF-69 C2: API returns year as string)", () => {
    const cands = [
      cand("a", "Topps Chrome", "Base", 2017, "Aaron Judge"),
      cand("b", "Topps Chrome", "Base", 2022, "Aaron Judge"),
      cand("c", "Topps Chrome", "Base", 2023, "Aaron Judge"),
    ];
    expect(filterByYearMatch(cands, 2017).map((c) => c.id)).toEqual(["a"]);
  });

  it("accepts string cardYear input", () => {
    const cands = [cand("a", "Topps Chrome", "Base", 2024, "Paul Skenes")];
    expect(filterByYearMatch(cands, "2024").map((c) => c.id)).toEqual(["a"]);
  });

  it("returns unfiltered when expectedYear is undefined", () => {
    const cands = [cand("a", "Topps Chrome", "Base", 2024, "Paul Skenes")];
    expect(filterByYearMatch(cands, undefined)).toEqual(cands);
  });

  it("passes candidates with missing year (throwback / buyback edge — don't reject)", () => {
    const cands = [
      cand("a", "Topps Chrome", "Base", 0, "Paul Skenes"),
      cand("b", "Topps Chrome", "Base", 2024, "Paul Skenes"),
    ];
    // Year-zero candidate passes the filter (zero treated as missing).
    expect(filterByYearMatch(cands, 2024).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("rejects candidates whose year differs (Judge 2022/2023 vs 2017 ask)", () => {
    const cands = [
      cand("2017", "Topps Chrome", "Base", 2017, "Aaron Judge"),
      cand("2022", "Topps Chrome", "Base", 2022, "Aaron Judge"),
      cand("2023", "Topps Chrome", "Base", 2023, "Aaron Judge"),
    ];
    expect(filterByYearMatch(cands, 2017).map((c) => c.id)).toEqual(["2017"]);
  });
});

describe("passesNameGuard", () => {
  it("accepts a candidate whose name contains all tokens of parsedPlayerName", () => {
    const c = cand("a", "Topps Chrome", "Base", 2018, "Ronald Acuna Jr.");
    expect(passesNameGuard(c, "Ronald Acuna Jr")).toBe(true);
  });

  it("rejects Luisangel Acuna when input.playerName = 'Ronald Acuna Jr' (load-bearing collision case)", () => {
    const luisangel = cand("l", "Topps Chrome", "Base", 2018, "Luisangel Acuna");
    expect(passesNameGuard(luisangel, "Ronald Acuna Jr")).toBe(false);
  });

  it("single-token playerName: requires that single token in candidate name", () => {
    const c = cand("a", "Topps Chrome", "Base", 2018, "Ronald Acuna");
    expect(passesNameGuard(c, "Acuna")).toBe(true);
    const trout = cand("t", "Topps Chrome", "Base", 2011, "Mike Trout");
    expect(passesNameGuard(trout, "Acuna")).toBe(false);
  });

  it("case-insensitive token matching", () => {
    const c = cand("a", "Topps Chrome", "Base", 2024, "PAUL SKENES");
    expect(passesNameGuard(c, "paul skenes")).toBe(true);
  });

  it("empty parsedPlayerName: passes trivially", () => {
    const c = cand("a", "Topps Chrome", "Base", 2024, "Paul Skenes");
    expect(passesNameGuard(c, "")).toBe(true);
  });

  it("missing candidate name: fails when there's a token to match", () => {
    const c = cand("a", "Topps Chrome", "Base", 2024, "");
    expect(passesNameGuard(c, "Paul Skenes")).toBe(false);
  });
});

// ───── Integration tests — hot-RC scenarios via _resolveCardId ───────────────

describe("_resolveCardId — hot-RC scenarios (Shape Y / Shape S routing)", () => {
  it("Skenes 2024 Topps Chrome: Shape Y returns 7 results, 0 exact-release-canonical → Shape S resolves canonical", async () => {
    // Shape Y: only adjacent releases (e.g. Topps Heritage, Topps Update) —
    // none with exact releaseName "Topps Chrome". The filter chain returns
    // empty on Y, triggering Shape S.
    const shapeYResults = [
      cand("heritage-1", "Topps Heritage", "Base Set", 2024, "Paul Skenes"),
      cand("heritage-2", "Topps Heritage", "Refractor", 2024, "Paul Skenes"),
      cand("update-1", "Topps Update", "Base Set", 2024, "Paul Skenes"),
      cand("finest-1", "Topps Finest", "Base Set", 2024, "Paul Skenes"),
      cand("series1-1", "Topps Series", "Base Set", 2024, "Paul Skenes"),
      cand("chrome-update-1", "Topps Chrome Update", "Base Set", 2024, "Paul Skenes"),
      cand("series2-1", "Topps Series", "Refractor", 2024, "Paul Skenes"),
    ];
    const shapeSResults = [
      cand("skenes-canonical-id", "Topps Chrome", "Base Set", 2024, "Paul Skenes"),
      cand("skenes-refractor", "Topps Chrome", "Refractor", 2024, "Paul Skenes"),
    ];
    let callCount = 0;
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      callCount++;
      if (query.includes("Paul Skenes RC")) return Promise.resolve(shapeYResults);
      if (query.startsWith("Skenes ")) return Promise.resolve(shapeSResults);
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockResolvedValue(pricing(50));

    const r = await resolveCardId({
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "topps chrome",
    });

    expect(r.cardId).toBe("skenes-canonical-id");
    // Shape Y AND Shape S fired (legacy never reached).
    expect(callCount).toBe(2);
  });

  it("Judge 2017 Topps Chrome: Shape Y returns canonical + same-player wrong-year variants → year filter picks 2017 base", async () => {
    const shapeYResults = [
      cand("judge-2017", "Topps Chrome", "Base Set", 2017, "Aaron Judge"),
      cand("judge-2022-buyback", "Topps Chrome", "Refractor MVP Buybacks", 2022, "Aaron Judge"),
      cand("judge-2023", "Topps Chrome", "Base Set", 2023, "Aaron Judge"),
      cand("judge-2022-base", "Topps Chrome", "Base Set", 2022, "Aaron Judge"),
      cand("judge-2017-refractor", "Topps Chrome", "Refractor", 2017, "Aaron Judge"),
    ];
    let shapeSCalled = false;
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Aaron Judge RC")) return Promise.resolve(shapeYResults);
      shapeSCalled = true;
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockImplementation((id: string) => {
      const recs = id === "judge-2017" ? 500 : id === "judge-2017-refractor" ? 100 : 0;
      return Promise.resolve(pricing(recs));
    });

    const r = await resolveCardId({
      playerName: "Aaron Judge",
      cardYear: 2017,
      product: "topps chrome",
    });

    // Year filter eliminates 2022 / 2023; name guard accepts all; canonical
    // setName preference picks judge-2017 over judge-2017-refractor.
    expect(r.cardId).toBe("judge-2017");
    // Shape S should NOT fire — Shape Y resolved cleanly.
    expect(shapeSCalled).toBe(false);
  });

  it("Ohtani 2018 Topps Chrome: Shape Y returns canonical → no S fallback", async () => {
    const shapeYResults = [
      cand("ohtani-2018", "Topps Chrome", "Base Set", 2018, "Shohei Ohtani"),
      cand("ohtani-2018-refractor", "Topps Chrome", "Refractor", 2018, "Shohei Ohtani"),
    ];
    let shapeSCalled = false;
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Shohei Ohtani RC")) return Promise.resolve(shapeYResults);
      shapeSCalled = true;
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockResolvedValue(pricing(50));

    const r = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "topps chrome",
    });

    expect(r.cardId).toBe("ohtani-2018");
    expect(shapeSCalled).toBe(false);
  });

  it("Acuña 2018 Topps Chrome with playerName='Ronald Acuna Jr': name-guard rejects Luisangel collision", async () => {
    // Shape Y returns BOTH Ronald and Luisangel Acuna (catalog catches both
    // via surname). Without name guard, Luisangel might rank higher in
    // pricing probe. Name guard requires ALL playerName tokens in candidate
    // name — Luisangel's name doesn't contain "Ronald".
    const shapeYResults = [
      cand("luisangel-acuna", "Topps Chrome", "Base Set", 2018, "Luisangel Acuna"),
      cand("ronald-acuna", "Topps Chrome", "Base Set", 2018, "Ronald Acuna Jr."),
      cand("ronald-acuna-refractor", "Topps Chrome", "Refractor", 2018, "Ronald Acuna Jr."),
    ];
    let shapeSCalled = false;
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Ronald Acuna Jr RC")) return Promise.resolve(shapeYResults);
      shapeSCalled = true;
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockImplementation((id: string) =>
      Promise.resolve(pricing(id === "luisangel-acuna" ? 1000 : 200)),
    );

    const r = await resolveCardId({
      playerName: "Ronald Acuna Jr",
      cardYear: 2018,
      product: "topps chrome",
    });

    // Name guard kicks out Luisangel before pricing probe even runs;
    // canonical setName preference picks ronald-acuna over ronald-acuna-refractor.
    expect(r.cardId).toBe("ronald-acuna");
    expect(shapeSCalled).toBe(false);
  });

  it("CF-69-FINISH documented residual: single-token playerName='Acuna' + Luisangel-only pool → resolves to Luisangel (intended, ambiguous query)", async () => {
    // CF-69-FINISH design choice (option C): the legacy name-guard fires
    // ONLY when input.playerName has 2+ tokens (multi-token = user
    // disambiguated). For single-token playerNames like "Acuna" alone,
    // the guard is STRUCTURALLY INERT — both Ronald Acuna and Luisangel
    // Acuna would pass the token-includes check (both names contain
    // "acuna"). So gating on 2+ tokens doesn't lose any disambiguation
    // we could have done; it just skips a guard that would no-op.
    //
    // This test documents the resulting residual: single-token namesake
    // queries are inherently ambiguous and the resolver picks via
    // pricing-probe scoring, NOT via name-guard. That's the legacy
    // back-compat path's pre-CF-69 behavior, intentionally preserved.
    // The user got an ambiguous best-effort result; not a regression.
    const luisangelOnlyPool = [
      cand("luisangel-acuna", "Topps Chrome", "Base Set", 2018, "Luisangel Acuna"),
    ];
    (cs.searchCatalog as any).mockImplementation(() => Promise.resolve(luisangelOnlyPool));
    (cs.getPricing as any).mockImplementation(() => Promise.resolve(pricing(500)));

    const r = await resolveCardId({
      playerName: "Acuna",  // single-token — gate skips, ambiguous query
      cardYear: 2018,
      product: "topps chrome",
    });

    // Intended: Luisangel resolves because the query "Acuna" is genuinely
    // ambiguous. Single-token namesake disambiguation isn't possible from
    // the query alone; the resolver returns the best-effort match.
    expect(r.cardId).toBe("luisangel-acuna");
  });

  it("CF-69-FINISH safety: pool contains ONLY Luisangel (Ronald absent) + query='Ronald Acuna Jr' → resolution stays empty, never ships Luisangel", async () => {
    // The load-bearing safety check: name-guard is NOT a relevance tier that
    // can fall back to namesake-containing yearFiltered when empty. It's a
    // safety filter — if no candidate's name contains all user-tokens, the
    // filter chain must return [], regardless of how clean release+year
    // matches look. Shape S retry runs (it might find Ronald in a different
    // shape), and ultimately the legacy fallback runs too. None of them
    // should EVER ship Luisangel just because no Ronald candidate exists.
    const luisangelOnlyPool = [
      cand("luisangel-acuna", "Topps Chrome", "Base Set", 2018, "Luisangel Acuna"),
      cand("luisangel-acuna-refractor", "Topps Chrome", "Refractor", 2018, "Luisangel Acuna"),
    ];
    // Mock searchCatalog to return Luisangel-only pool on EVERY shape (Y, S,
    // and legacy). This simulates a catalog state where Ronald genuinely
    // isn't indexed under the queries our shapes generate.
    (cs.searchCatalog as any).mockImplementation(() => Promise.resolve(luisangelOnlyPool));
    // If the code accidentally falls through to pricing Luisangel, this would
    // make him pop into the disambiguation pool.
    (cs.getPricing as any).mockImplementation(() => Promise.resolve(pricing(500)));

    const r = await resolveCardId({
      playerName: "Ronald Acuna Jr",
      cardYear: 2018,
      product: "topps chrome",
    });

    // The critical assertion: NEVER Luisangel, regardless of what else
    // happens to cardId. Empty resolution is acceptable; legacy fallback
    // may still find something via its different query shape (if it does,
    // it must ALSO pass name-guard). But Luisangel is the failure mode.
    expect(r.cardId).not.toBe("luisangel-acuna");
    expect(r.cardId).not.toBe("luisangel-acuna-refractor");
  });
});

// ───── Judge MVP-Buyback case (setName preference) ──────────────────────────

describe("_resolveCardId — Judge 2022 Topps Chrome MVP-Buybacks (setName preference)", () => {
  it("Shape Y returns Judge canonical base + Judge MVP Buyback (same releaseName, different setName) → canonical chosen", async () => {
    // Both candidates share releaseName "Topps Chrome" — only setName
    // disambiguates. Without isCanonicalSetName, pricing-probe might pick
    // the buyback if it has more records.
    const shapeYResults = [
      cand("judge-buyback", "Topps Chrome", "Refractor MVP Buybacks", 2022, "Aaron Judge"),
      cand("judge-base-2022", "Topps Chrome", "Base Set", 2022, "Aaron Judge"),
    ];
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Aaron Judge RC")) return Promise.resolve(shapeYResults);
      return Promise.resolve([]);
    });
    // Make buyback have HIGHER pricing-probe count to confirm setName
    // preference runs BEFORE pricing probe (otherwise buyback would win).
    (cs.getPricing as any).mockImplementation((id: string) =>
      Promise.resolve(pricing(id === "judge-buyback" ? 2000 : 100)),
    );

    const r = await resolveCardId({
      playerName: "Aaron Judge",
      cardYear: 2022,
      product: "topps chrome",
    });

    expect(r.cardId).toBe("judge-base-2022");
  });
});

// ───── Back-compat: legacy fallback ─────────────────────────────────────────

describe("_resolveCardId — back-compat legacy fallback", () => {
  it("Shape Y + Shape S both empty → legacy path fires with original substring release filter", async () => {
    // Mock: all queries return empty for Shape Y + Shape S, but the
    // legacy `{player} {releaseName}` query (no "RC" suffix) returns one
    // result. Verifies the legacy fallback genuinely re-fires search.
    let legacyFired = false;
    (cs.searchCatalog as any).mockImplementation((query: string, opts: any) => {
      // Legacy query has no "RC" suffix and DOES carry year= filter.
      const isLegacy = !query.includes(" RC") && opts?.year != null;
      if (isLegacy) {
        legacyFired = true;
        return Promise.resolve([
          cand("legacy-hit", "Topps Chrome", "Base Set", 2024, "Some Player"),
        ]);
      }
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockResolvedValue(pricing(10));

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "topps chrome",
    });

    expect(r.cardId).toBe("legacy-hit");
    expect(legacyFired).toBe(true);
  });

  it("non-flagship query (product NOT in dictionary): Shape Y skipped, legacy fires immediately", async () => {
    // product="random brand" → releaseName=null → buildShapeYQuery returns
    // null → Shape Y skipped entirely → legacy fires as the first call.
    let callCount = 0;
    (cs.searchCatalog as any).mockImplementation((query: string, opts: any) => {
      callCount++;
      // First call should be the legacy query (no "RC" suffix, has year=)
      expect(query).not.toContain(" RC");
      expect(opts?.year).toBe(2024);
      return Promise.resolve([
        cand("non-flagship-hit", "Random Brand", "Base Set", 2024, "Some Player"),
      ]);
    });
    (cs.getPricing as any).mockResolvedValue(pricing(10));

    const r = await resolveCardId({
      playerName: "Some Player",
      cardYear: 2024,
      product: "random brand",
    });

    expect(r.cardId).toBe("non-flagship-hit");
    expect(callCount).toBe(1);
  });
});

// ───── Filter-chain cascade behavior ────────────────────────────────────────

describe("_resolveCardId — filter-chain cascade (setName-canonical empty fallback)", () => {
  it("setName-canonical empty but name-guard non-empty → use name-guard set (Chrome Prospects edge)", async () => {
    // Chrome Prospects setName ("Chrome Prospects" doesn't match the
    // canonical regex). Without the cascade, all candidates would be
    // filtered out at the setName step. With cascade, name-guard set
    // is kept.
    const shapeYResults = [
      cand("prospect-1", "Topps Chrome", "Chrome Prospects", 2024, "Paul Skenes"),
      cand("prospect-2", "Topps Chrome", "Chrome Prospects", 2024, "Paul Skenes"),
    ];
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Paul Skenes RC")) return Promise.resolve(shapeYResults);
      return Promise.resolve([]);
    });
    (cs.getPricing as any).mockImplementation((id: string) =>
      Promise.resolve(pricing(id === "prospect-1" ? 100 : 50)),
    );

    const r = await resolveCardId({
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "topps chrome",
    });

    // Neither candidate has canonical setName, so the cascade falls back
    // to the name-guard set; pricing-probe picks the higher-records one.
    expect(["prospect-1", "prospect-2"]).toContain(r.cardId);
  });
});
