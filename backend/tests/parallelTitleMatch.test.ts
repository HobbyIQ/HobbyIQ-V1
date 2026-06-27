// CF-CARDSIGHT-RESOLVER-REDESIGN — pure-function tests for
// parallelTitleMatch.applyParallelTitleMatch.
//
// Covers all 7 internal priceSource branches + the 7→3 user-facing
// collapse + the specificity guard via exclusion using Trout 2021
// Topps Chrome's 23-parallel fixture as the canonical stress test.

import { describe, it, expect } from "vitest";
import {
  applyParallelTitleMatch,
  collapsePriceSource,
  type ParallelTitleMatchInput,
} from "../src/services/compiq/parallelTitleMatch.js";
import type { CardsightPricingResponse } from "../src/services/compiq/catalogSource.js";
import { tokenizeParallel } from "../src/services/compiq/parallelTokenizer.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function rec(price: number, title: string, date = "2026-05-01"): {
  price: number;
  title: string;
  date: string;
  source: string;
  url: string | null;
} {
  return { price, title, date, source: "ebay", url: null };
}

function pricingResponse(opts: {
  rawTitles?: string[];
  graded?: Array<{ company: string; grade: string; titles: string[] }>;
  fellBack?: boolean;
}): CardsightPricingResponse {
  return {
    raw: {
      count: opts.rawTitles?.length ?? 0,
      records: (opts.rawTitles ?? []).map((t, i) => rec(100 + i, t)),
    },
    graded: (opts.graded ?? []).map(({ company, grade, titles }) => ({
      company_name: company,
      grades: [
        {
          grade_value: grade,
          count: titles.length,
          records: titles.map((t, i) => rec(200 + i, t)),
        },
      ],
    })),
    meta: { total_records: 0, last_sale_date: null },
    __parallelIdFilterFellBack: opts.fellBack,
  };
}

// Trout 2021 Topps Chrome catalog parallels (from schema doc §3).
const TROUT_2021_TOPPS_CHROME_PARALLELS = [
  { id: "p-aqua-refractor", name: "Aqua Refractor" },
  { id: "p-aqua-wave-refractor", name: "Aqua Wave Refractor" },
  { id: "p-bw-mini-diamond", name: "Black & White Mini Diamond Refractor" },
  { id: "p-blue-refractor", name: "Blue Refractor" },
  { id: "p-blue-wave-refractor", name: "Blue Wave Refractor" },
  { id: "p-gold-refractor", name: "Gold Refractor" },
  { id: "p-gold-wave-refractor", name: "Gold Wave Refractor" },
  { id: "p-green-refractor", name: "Green Refractor" },
  { id: "p-green-wave-refractor", name: "Green Wave Refractor" },
  { id: "p-magenta-refractor", name: "Magenta Refractor" },
  { id: "p-magenta-speckle", name: "Magenta Speckle Refractor" },
  { id: "p-negative-bw-refractor", name: "Negative Black & White Refractor" },
  { id: "p-orange-refractor", name: "Orange Refractor" },
  { id: "p-orange-wave-refractor", name: "Orange Wave Refractor" },
  { id: "p-pink-refractor", name: "Pink Refractor" },
  { id: "p-printing-plates", name: "Printing Plates" },
  { id: "p-prism-refractor", name: "Prism Refractor" },
  { id: "p-purple-refractor", name: "Purple Refractor" },
  { id: "p-red-refractor", name: "Red Refractor" },
  { id: "p-red-wave-refractor", name: "Red Wave Refractor" },
  { id: "p-refractor", name: "Refractor" },
  { id: "p-sepia-refractor", name: "Sepia Refractor" },
  { id: "p-superfractor", name: "SuperFractor" },
];

const MADDUX_1987_PARALLELS = [
  { id: "p-limited-edition-tiffany", name: "Limited Edition (Tiffany)" },
];

function baseInput(
  overrides: Partial<ParallelTitleMatchInput> = {},
): ParallelTitleMatchInput {
  return {
    pricingResponse: pricingResponse({}),
    pricingCameFromUnifiedFallback: false,
    userParallelInput: null,
    matchedParallelId: null,
    siblingParallels: [],
    ...overrides,
  };
}

// ─── 7 internal priceSource branches ───────────────────────────────────────

describe("applyParallelTitleMatch — 7 internal priceSource values", () => {
  it("unified-no-parallel: no user input → unfiltered, no match", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        pricingResponse: pricingResponse({ rawTitles: ["a", "b", "c"] }),
      }),
    );
    expect(r.priceSource).toBe("unified-no-parallel");
    expect(r.filteredCount).toBe(3);
  });

  it("unified-no-cardsight-match: user input but parallelId null → integrity-gate suppresses", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "garbage parallel xyz",
        matchedParallelId: null,
        pricingResponse: pricingResponse({ rawTitles: ["a", "b", "c"] }),
      }),
    );
    expect(r.priceSource).toBe("unified-no-cardsight-match");
    expect(r.filteredCount).toBe(3);
  });

  it("cardsight-parallel-id: parallel_id filter delivered (not fallback) → no title-match", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: false,
        pricingResponse: pricingResponse({
          rawTitles: ["2021 Topps Chrome Blue Refractor 32/150 Mike Trout"],
        }),
      }),
    );
    expect(r.priceSource).toBe("cardsight-parallel-id");
    expect(r.filteredCount).toBe(1);
  });

  it("title-matched-parallel: fallback + distinctive parallel + ≥3 records", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "TIFFANY",
        matchedParallelId: "p-limited-edition-tiffany",
        siblingParallels: MADDUX_1987_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          graded: [
            {
              company: "PSA",
              grade: "10",
              titles: [
                "1987 Topps Traded Tiffany Greg Maddux PSA 10",
                "1987 TOPPS TRADED TIFFANY MADDUX PSA 10 GEM",
                "1987 Topps Tiffany Traded Maddux RC PSA 10",
                "1987 TOPPS TRADED #70T GREG MADDUX ROOKIE RC PSA 10",
                "1987 Topps Traded - #70T Greg Maddux (RC) PSA 10",
              ],
            },
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
    expect(r.totalUnifiedCount).toBe(5);
    expect(r.matchTokens).toEqual(["tiffany"]);
    expect(r.excludedTokens).toEqual([]);
  });

  it("title-match-low-sample: fallback + match yields 1-2 records", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "TIFFANY",
        matchedParallelId: "p-limited-edition-tiffany",
        siblingParallels: MADDUX_1987_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          graded: [
            {
              company: "PSA",
              grade: "10",
              titles: [
                "1987 Topps Traded Tiffany Greg Maddux PSA 10",
                "1987 TOPPS TRADED #70T GREG MADDUX ROOKIE RC PSA 10",
                "1987 Topps Traded - #70T Greg Maddux (RC) PSA 10",
              ],
            },
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-match-low-sample");
    expect(r.filteredCount).toBe(1);
    expect(r.totalUnifiedCount).toBe(3);
  });

  it("unified-fallback-no-match: fallback + title-match produces 0 records → return original unchanged", () => {
    const unified = pricingResponse({
      graded: [
        { company: "PSA", grade: "10", titles: ["Base Maddux PSA 10 only", "Another base PSA 10"] },
      ],
    });
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "TIFFANY",
        matchedParallelId: "p-limited-edition-tiffany",
        siblingParallels: MADDUX_1987_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: unified,
      }),
    );
    expect(r.priceSource).toBe("unified-fallback-no-match");
    expect(r.filteredCount).toBe(0);
    // Critical: response is the ORIGINAL unfiltered set (never collapse to empty)
    expect(r.response).toBe(unified);
    expect(r.totalUnifiedCount).toBe(2);
  });
});

// ─── 7→3 user-facing collapse ──────────────────────────────────────────────

describe("collapsePriceSource — 7 internal → 3 user-facing", () => {
  it("exact: cardsight-parallel-id + title-matched-parallel", () => {
    expect(collapsePriceSource("cardsight-parallel-id")).toBe("exact");
    expect(collapsePriceSource("title-matched-parallel")).toBe("exact");
  });

  it("approximate: title-match-low-sample + unified-fallback-generic", () => {
    expect(collapsePriceSource("title-match-low-sample")).toBe("approximate");
    expect(collapsePriceSource("unified-fallback-generic")).toBe("approximate");
  });

  it("broad: unified-fallback-no-match + unified-no-parallel + unified-no-cardsight-match", () => {
    expect(collapsePriceSource("unified-fallback-no-match")).toBe("broad");
    expect(collapsePriceSource("unified-no-parallel")).toBe("broad");
    expect(collapsePriceSource("unified-no-cardsight-match")).toBe("broad");
  });
});

// ─── Specificity guard — Trout 23-parallel stress test ────────────────────

describe("applyParallelTitleMatch — specificity guard against Trout 2021 Topps Chrome (23 parallels)", () => {
  it("user 'Refractor' (subset of nearly all siblings): exclusion guard fires, excludes color/wave tokens", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Refractor",
        matchedParallelId: "p-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Mike Trout 2021 Topps Chrome Refractor #27",        // ← match
            "Mike Trout 2021 Topps Chrome Refractor base RC",     // ← match
            "Mike Trout 2021 Topps Chrome Refractor",             // ← match
            "Mike Trout 2021 Topps Chrome Blue Refractor 32/150", // ← excluded (blue)
            "Mike Trout 2021 Topps Chrome Gold Refractor /50",    // ← excluded (gold)
            "Mike Trout 2021 Topps Chrome Blue Wave Refractor",   // ← excluded (blue + wave)
            "Mike Trout 2021 Topps Chrome SuperFractor /1",       // ← excluded (super)
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
    expect(r.matchTokens).toEqual(["refractor"]);
    // distinguishing tokens come from siblings that are PROPER SUPERSETS
    // of userTokens. "Blue Refractor" has ["blue", "refractor"] which is a
    // superset of ["refractor"], so "blue" is distinguishing. Same for
    // wave, gold, etc. across the colored-refractor siblings.
    expect(r.excludedTokens).toContain("blue");
    expect(r.excludedTokens).toContain("gold");
    expect(r.excludedTokens).toContain("wave");
    // "SuperFractor" tokenizes to ["superfractor"] — a SINGLE fused word,
    // NOT a superset of ["refractor"]. So "superfractor" is NOT a
    // distinguishing token. However, word-boundary match prevents user
    // token "refractor" from matching "superfractor" inside titles — so
    // SuperFractor sales are correctly excluded from the filtered set
    // via the match-side word-boundary semantics, not via exclusion.
    expect(r.excludedTokens).not.toContain("superfractor");
  });

  it("user 'Blue Refractor' (subset of Blue Wave Refractor): excludes 'wave'", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Mike Trout 2021 Topps Chrome Blue Refractor 32/150 #27",     // ← match
            "Mike Trout 2021 Topps Chrome Blue Refractor 100/150 RC",     // ← match
            "Mike Trout 2021 Topps Chrome Blue Refractor #27",            // ← match
            "Mike Trout 2021 Topps Chrome Blue Wave Refractor 12/75",     // ← excluded (wave)
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
    expect(r.excludedTokens).toEqual(["wave"]);
  });

  it("user 'Blue Wave Refractor' (no super-set sibling): strict ALL-tokens match, no exclusion", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Wave Refractor",
        matchedParallelId: "p-blue-wave-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Mike Trout 2021 Topps Chrome Blue Wave Refractor 12/75",   // ← match
            "Mike Trout 2021 Topps Chrome Blue Wave Refractor #27",     // ← match
            "Mike Trout 2021 Topps Chrome Blue Wave Refractor RC",      // ← match
            "Mike Trout 2021 Topps Chrome Blue Refractor 100/150",      // ← no (no wave token)
            "Mike Trout 2021 Topps Chrome Refractor",                   // ← no (no blue, no wave)
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
    expect(r.matchTokens.sort()).toEqual(["blue", "refractor", "wave"]);
    expect(r.excludedTokens).toEqual([]);
  });

  it("user 'SuperFractor' (distinctive, no super-set siblings): strict match, no exclusion", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "SuperFractor",
        matchedParallelId: "p-superfractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Mike Trout 2021 Topps Chrome SuperFractor 1/1",      // ← match
            "Mike Trout 2021 Topps Chrome SuperFractor /1 RC",    // ← match
            "Mike Trout 2021 Topps Chrome Pink Refractor",        // ← no (no superfractor)
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-match-low-sample");
    expect(r.filteredCount).toBe(2);
    expect(r.matchTokens).toEqual(["superfractor"]);
    expect(r.excludedTokens).toEqual([]);
  });

  it("token-order independence: 'Refractor Blue' tokenizes same as 'Blue Refractor'", () => {
    const r1 = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: ["Blue Refractor sale 1", "Blue Refractor sale 2", "Blue Refractor sale 3"],
        }),
      }),
    );
    const r2 = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Refractor Blue",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: ["Blue Refractor sale 1", "Blue Refractor sale 2", "Blue Refractor sale 3"],
        }),
      }),
    );
    expect(r1.matchTokens.sort()).toEqual(r2.matchTokens.sort());
    expect(r1.filteredCount).toBe(r2.filteredCount);
  });
});

// ─── Word-boundary regression guard ───────────────────────────────────────

describe("applyParallelTitleMatch — word-boundary semantics (NOT substring)", () => {
  it("user 'Refractor' does NOT over-pull SuperFractor titles (word-boundary prevents substring over-match)", () => {
    // Critical regression guard: a substring match `"superfractor".includes("refractor")`
    // would over-pull every SuperFractor /1 sale (high value!) into a "Refractor"
    // base filter. Word-boundary regex (\brefractor\b) prevents this.
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Refractor",
        matchedParallelId: "p-refractor",
        siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Mike Trout 2021 Topps Chrome Refractor #27",       // ← match (word-boundary)
            "Mike Trout 2021 Topps Chrome Refractor base",       // ← match
            "Mike Trout 2021 Topps Chrome Refractor RC",         // ← match
            "Mike Trout 2021 Topps Chrome SuperFractor 1/1",     // ← MUST NOT match
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3); // NOT 4 — SuperFractor excluded
    // No "superfractor" title in the filtered set (substring would have pulled it)
    const filteredTitles = r.response.raw.records.map((rec) => rec.title.toLowerCase());
    expect(filteredTitles.every((t) => !t.includes("superfractor"))).toBe(true);
  });
});

// ─── CF-PINNED-PARALLEL-RECOVERY (2026-06-11): span-scoped finish-vocab backstop ────
// Live find (Leo De Vries Blue Refractor /150 probe, SHA 7956d2a):
// the registry-based specificity guard had zero coverage because
// Cardsight's detail.parallels[] for Leo's base cardId omitted "Blue
// Wave Refractor" — so the registry guard built no distinguishing
// tokens and a $285 Blue Wave leaked into the Blue Refractor pool. The
// vocab backstop is registry-INDEPENDENT: it detects extra finish
// tokens INTERIOR to the user-token span in candidate titles. These
// tests sit alongside the existing registry-based guard tests above —
// they use a deliberately MINIMAL siblingParallels (just the matched
// parallel) so the vocab is the only thing doing the work.

describe("applyParallelTitleMatch — span-scoped finish-vocab backstop (registry-independent)", () => {
  // Minimal sibling list — only the matched parallel. The registry
  // guard collects ZERO distinguishingTokens from this list, so any
  // rejection MUST come from the vocab backstop.
  const REGISTRY_OMITTED_SIBLINGS = [
    { id: "p-blue-refractor", name: "Blue Refractor" },
  ];

  it("EXCLUDE — 'Blue Wave Refractor /150' (interior 'wave', registry omitted)", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "2024 Bowman Chrome 1st Autograph Leo De Vries CPA-LD Blue Refractor /150",
            "2024 Bowman Chrome 1st Autograph Leo De Vries CPA-LD Blue Refractor /150 RC",
            "2024 Bowman Chrome 1st Autograph Leo De Vries CPA-LD Blue Refractor /150 #27",
            "2024 Bowman Chrome 1st Autograph Leo De Vries CPA-LD Blue Wave Refractor /150",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
    const titles = r.response.raw.records.map((rec) => rec.title.toLowerCase());
    expect(titles.every((t) => !t.includes("wave"))).toBe(true);
  });

  it("EXCLUDE — 'Blue Shimmer Refractor /150' (interior 'shimmer', registry omitted)", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 a",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 b",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 c",
            "2024 Bowman Chrome Leo De Vries Blue Shimmer Refractor /150",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
    const titles = r.response.raw.records.map((rec) => rec.title.toLowerCase());
    expect(titles.every((t) => !t.includes("shimmer"))).toBe(true);
  });

  it("EXCLUDE — 'Blue Atomic Refractor /100' (interior 'atomic', registry omitted)", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 a",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 b",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 c",
            "2024 Bowman Chrome Leo De Vries Blue Atomic Refractor /100",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
    const titles = r.response.raw.records.map((rec) => rec.title.toLowerCase());
    expect(titles.every((t) => !t.includes("atomic"))).toBe(true);
  });

  it("EXCLUDE — 'Gold Refractor /50' (fails user-token \\bblue\\b; sanity)", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 a",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 b",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 c",
            "2024 Bowman Chrome Leo De Vries Gold Refractor /50",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
    const titles = r.response.raw.records.map((rec) => rec.title.toLowerCase());
    expect(titles.every((t) => !t.includes("gold"))).toBe(true);
  });

  it("KEEP — 'BLUE REFRACTOR AUTO 30/150' (auto is a CATEGORY_LABEL)", () => {
    // Auto/autograph/refractor/base are common-category tokens that
    // describe the card kind, not the finish — they must not trigger
    // sibling rejection even though they appear in canonical parallel
    // names (e.g. "Base Auto" is the unnumbered auto baseline).
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "LEO DE VRIES 2024 BOWMAN CHROME #CPA-LD 1ST PROSPECT BLUE REFRACTOR AUTO 30/150",
            "LEO DE VRIES 2024 BOWMAN CHROME #CPA-LD BLUE REFRACTOR AUTO 31/150",
            "Leo De Vries 2024 Bowman Chrome Blue Refractor Auto 32/150",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
  });

  it("KEEP — 'Boston Red Sox ... Blue Refractor /150' ('red' is team context, OUTSIDE span)", () => {
    // Span-scoping point: color/finish vocab tokens that appear in
    // team/player context — strictly OUTSIDE the user-token span —
    // must not trigger rejection. The user-token span here is
    // ["blue", "refractor"]; "red" sits before "blue" in the title.
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Rafael Devers Boston Red Sox 2024 Topps Chrome Blue Refractor /150 a",
            "Rafael Devers Boston Red Sox 2024 Topps Chrome Blue Refractor /150 b",
            "Rafael Devers Boston Red Sox 2024 Topps Chrome Blue Refractor /150 c",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
  });

  it("KEEP — 'Toronto Blue Jays ... Gold Refractor /50' ('blue' is team context, OUTSIDE span)", () => {
    // Same span-scoping point with the user's color flipped. User
    // tokens here are ["gold", "refractor"]; "blue" lives in "Blue
    // Jays" upstream of the parallel descriptor.
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Gold Refractor",
        matchedParallelId: "p-gold-refractor",
        siblingParallels: [{ id: "p-gold-refractor", name: "Gold Refractor" }],
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "Vladimir Guerrero Jr Toronto Blue Jays 2024 Topps Chrome Gold Refractor /50 a",
            "Vladimir Guerrero Jr Toronto Blue Jays 2024 Topps Chrome Gold Refractor /50 b",
            "Vladimir Guerrero Jr Toronto Blue Jays 2024 Topps Chrome Gold Refractor /50 c",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
  });

  it("KEEP — clean 'Blue Refractor /150' target (no vocab tokens in span)", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "Blue Refractor",
        matchedParallelId: "p-blue-refractor",
        siblingParallels: REGISTRY_OMITTED_SIBLINGS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          rawTitles: [
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 a",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 b",
            "2024 Bowman Chrome Leo De Vries Blue Refractor /150 c",
          ],
        }),
      }),
    );
    expect(r.filteredCount).toBe(3);
  });
});

// ─── Safety: graded-bucket filtering preserves structure ──────────────────

describe("applyParallelTitleMatch — graded-bucket filtering", () => {
  it("filters records inside graded[company][grade].records, drops empty grades/companies", () => {
    const r = applyParallelTitleMatch(
      baseInput({
        userParallelInput: "TIFFANY",
        matchedParallelId: "p-limited-edition-tiffany",
        siblingParallels: MADDUX_1987_PARALLELS,
        pricingCameFromUnifiedFallback: true,
        pricingResponse: pricingResponse({
          graded: [
            {
              company: "PSA",
              grade: "10",
              titles: [
                "1987 Topps Tiffany Maddux PSA 10",
                "1987 Topps Tiffany Maddux PSA 10",
                "1987 Topps Tiffany Maddux PSA 10",
                "1987 Topps Maddux base PSA 10",  // ← excluded
              ],
            },
          ],
        }),
      }),
    );
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
    // Graded PSA company present; only 3 records (base excluded)
    expect(r.response.graded.length).toBe(1);
    expect(r.response.graded[0].company_name).toBe("PSA");
    expect(r.response.graded[0].grades[0].records.length).toBe(3);
  });
});

describe("CF-PARALLEL-PLURAL-NORMALIZE — singular ↔ plural matcher", () => {
  // The catalog double-catalogs many finishes (Refractor + Refractors,
  // Speckle Refractor + Speckle Refractors, etc.). Token-side
  // singularization (cardsight.mapper.tokenizeParallel) collapses the
  // catalog names; regex-side `s?` (buildWordBoundaryPattern via
  // PARALLEL_SINGULAR_TOKENS) makes title matching tolerate either
  // spelling.
  it("user 'Refractor' matches titles spelling 'Refractor' AND 'Refractors'", () => {
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Refractor",
      matchedParallelId: "p-refractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: TROUT_2021_TOPPS_CHROME_PARALLELS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "2021 Topps Chrome Mike Trout Refractor #1",            // singular
          "2021 Topps Chrome Mike Trout Refractors Auto #1",      // plural
          "2021 Topps Chrome Mike Trout Blue Refractor /150 #1",  // distinguishing-token excluded
        ],
      }),
    }));
    expect(r.priceSource).toBe("title-match-low-sample"); // < 3 records
    expect(r.filteredCount).toBe(2); // singular + plural both pooled; Blue excluded
  });

  it("plural sibling collapses to singular canonical key — no spurious distinguishing tokens", () => {
    // If "Refractor" and "Refractors" coexist as siblings, the plural
    // must NOT generate distinguishing tokens against the singular
    // (their canonical token sets are equal). The matcher's filter
    // `sTokens.length <= userTokens.length` already handles this, but
    // verify defensively post-singularization.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Refractor",
      matchedParallelId: "p-refractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: [
        ...TROUT_2021_TOPPS_CHROME_PARALLELS,
        { id: "p-refractors", name: "Refractors" }, // plural duplicate
      ],
      pricingResponse: pricingResponse({
        rawTitles: [
          "2021 Topps Chrome Mike Trout Refractor #1",
          "2021 Topps Chrome Mike Trout Refractors Auto #1",
          "2021 Topps Chrome Mike Trout Refractor /150 #1",
        ],
      }),
    }));
    // excludedTokens must NOT contain "refractor" / "refractors" — the
    // plural sibling is a canonical equal, not a proper superset.
    expect(r.excludedTokens).not.toContain("refractor");
    expect(r.excludedTokens).not.toContain("refractors");
  });
});

// CF-X3 (2026-06-20) — X-Fractor family token canonicalization.
//
// Audit (cf-x2-audit-3.cjs, full 2026 Bowman release sweep): Cardsight
// spells the X-Fractor parallel in three forms in title strings:
//   • "X-Fractor"  (hyphen, mixed/lower case)         — 261/393 ~66%
//   • "Xfractor"   (smooshed, no separator)           —  36/393 ~9%
//   • "x fractor"  (space)                            —   3/393 ~1%
//   • "X-FRACTOR"  (CAPS hyphen)                      —  93/393 ~24%, case-insensitive variant of #1
//   • "X-fractors" (plural)                           —   1/393, recovered via PARALLEL_SINGULAR_TOKENS
//
// Pre-fix: `tokenizeParallel("Blue X-Fractor /150")` split on hyphen to
// `["blue", "x", "fractor", "150"]`. `\bx\b` then failed to find the
// "x" inside a smooshed "Xfractor" title (no word boundary between x and
// f) — 6 of 49 Blue X-Fractor /150 auto sales silently skipped (~12%),
// with the wider X-Fractor pool seeing a ~9% miss.
//
// Fix: tokenizeParallel pre-replaces `\bx[-\s]?fractor\b` → `xfractor`
// (word-boundary anchored so "Lex-Fractor"-shaped strings stay
// untouched); buildWordBoundaryPattern special-cases the `xfractor`
// token to emit `\bx[-\s]?fractors?\b` covering all five title shapes.
describe("CF-X3 — X-Fractor family token canonicalization", () => {
  const BOWMAN_CPA_2026_SIBLINGS = [
    { id: "p-blue-xfractor", name: "Blue X-Fractor" },
    { id: "p-yellow-xfractor", name: "Yellow X-Fractor" },
    { id: "p-orange-xfractor", name: "Orange X-Fractor" },
    { id: "p-blue-refractor", name: "Blue RayWave Refractor" },
    { id: "p-base-auto", name: "Base" },
  ];

  it("recovers the 6 known SKIPS from cf-x2-audit-3 (Blue Xfractor smoosh + plural)", () => {
    // These six titles are the actual SKIPPED sales from the wider
    // 2026 Bowman release probe — pre-fix the engine missed all six.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue X-Fractor /150",
      matchedParallelId: "p-blue-xfractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: BOWMAN_CPA_2026_SIBLINGS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "2026 Bowman Chrome Andrew Tess 1st Bowman  Blue Xfractor Auto /150 #CPA-AT CLEAN",
          "2026 Bowman Chrome Andrew Tess 1st Bowman  Blue Xfractor Auto /150 #CPA-AT CLEAN",
          "2026 Bowman Baseball Daniel Dickinson 1st Bowman Auto Blue Xfractor /150 #CPA-DD",
          "2026 Bowman Chrome Kehden Hettiger 1st Blue Xfractor Auto /150 #CPA-KHE",
          "2026 Bowman Pablo Nunez 1st Blue Xfractor Auto /150 - Reds #CPA-PN",
          "2026 Bowman Chrome Konnor Griffin #BCP-92 Blue Xfractor /150",
        ],
      }),
    }));
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(6);
  });

  it("matches all three spellings (hyphen / smoosh / space) and CAPS / plural forms", () => {
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue X-Fractor /150",
      matchedParallelId: "p-blue-xfractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: BOWMAN_CPA_2026_SIBLINGS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "2026 Bowman Chrome Adrian Gil #CPA-AG Blue X-Fractor Auto /150 RC",   // hyphen
          "2026 Bowman Chrome Andrew Tess 1st Blue Xfractor Auto /150 #CPA-AT",  // smoosh
          "2026 Bowman Player Name 1st Blue X Fractor /150 #CPA-XY",             // space
          "ETHAN HOLLIDAY 2026 BOWMAN CHROME BLUE X-FRACTOR /150 #CPA-EH",       // CAPS hyphen
          "2026 Bowman - Wehiwa Aloy 1st Bowman Chrome Blue X-fractors /150 #CPA-WA", // plural
        ],
      }),
    }));
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(5);
  });

  it("cross-family guard: 'Blue Refractor' query does NOT match X-Fractor titles", () => {
    // The critical anti-regression: a user querying a Refractor must
    // never accidentally match X-Fractor titles after the
    // canonicalization. Different tokens, different regex.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue Refractor",
      matchedParallelId: "p-blue-refractor-real", // pretend a separate parallel exists
      pricingCameFromUnifiedFallback: true,
      siblingParallels: [
        ...BOWMAN_CPA_2026_SIBLINGS,
        { id: "p-blue-refractor-real", name: "Blue Refractor" },
      ],
      pricingResponse: pricingResponse({
        rawTitles: [
          "2026 Bowman Chrome Player Blue X-Fractor /150 #CPA-XX",         // X-Fractor — must NOT match
          "2026 Bowman Chrome Player Blue Xfractor Auto /150 #CPA-YY",     // X-Fractor smoosh — must NOT match
          "2026 Bowman Chrome Player Blue Refractor /150 #CPA-ZZ",         // genuine Refractor — must match
        ],
      }),
    }));
    expect(r.filteredCount).toBe(1);
  });

  it("anti-regression: existing 'Blue X-Fractor /150' hyphen titles still match", () => {
    // Pre-fix this case worked. The fix must not regress the 261/393
    // hyphen-spelled titles that were already matching.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue X-Fractor /150",
      matchedParallelId: "p-blue-xfractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: BOWMAN_CPA_2026_SIBLINGS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "2026 Bowman Chrome 1st Anthony Frobose Auto /150 Blue X-Fractor #BCP-85 Mets",
          "2026 Bowman Chrome Breyson Guedez #CPA-BG 1st Auto Blue X-Fractor /150 Athletics",
          "2026 Topps Bowman Chrome Auto Charlie Condon 13/150 Blue X-Fractor #CPA-CC",
        ],
      }),
    }));
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
  });

  it("Yellow X-Fractor sibling produces 'yellow' as distinguishing token; Blue X-Fractor query rejects Yellow titles", () => {
    // Specificity guard still works on color tokens post-canonicalization:
    // 'Blue X-Fractor' siblings include 'Yellow X-Fractor' → 'yellow'
    // is excluded → titles with 'Yellow X-Fractor' (any spelling) are rejected.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue X-Fractor",
      matchedParallelId: "p-blue-xfractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: BOWMAN_CPA_2026_SIBLINGS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "Player Blue X-Fractor Auto /150 #CPA",
          "Player Blue Xfractor /150 #CPA",
          "Player Blue X Fractor /150 #CPA",        // all three Blue → match (≥3 = title-matched-parallel)
          "Player Yellow X-Fractor Auto /75 #CPA",  // Yellow → reject (no 'blue' in title)
          "Player Yellow Xfractor /75 #CPA",        // Yellow smoosh → reject
        ],
      }),
    }));
    expect(r.priceSource).toBe("title-matched-parallel");
    expect(r.filteredCount).toBe(3);
  });

  it("Lex-Fractor-shaped strings (hypothetical adjacency) are NOT normalized — word-boundary anchor holds", () => {
    // The pre-replace uses \b before 'x' to ensure that a substring
    // ending in 'x' (preceded by a word char) is NOT consumed. There's
    // no real "Lex-Fractor" parallel — this is purely a guard test.
    const r = applyParallelTitleMatch(baseInput({
      userParallelInput: "Blue X-Fractor",
      matchedParallelId: "p-blue-xfractor",
      pricingCameFromUnifiedFallback: true,
      siblingParallels: BOWMAN_CPA_2026_SIBLINGS,
      pricingResponse: pricingResponse({
        rawTitles: [
          "Player Blue Lex-Fractor /150 #CPA",   // 'Lex-Fractor' must NOT be treated as X-Fractor → no match
          "Player Blue X-Fractor /150 #CPA",     // genuine → match
        ],
      }),
    }));
    expect(r.filteredCount).toBe(1);
  });
});

// CF-X3 — direct tokenizeParallel unit tests (the input-side half of the fix).
describe("CF-X3 — tokenizeParallel canonicalizes X-Fractor family to a single token", () => {
  it("'Blue X-Fractor' → ['blue', 'xfractor']", () => {
    expect(tokenizeParallel("Blue X-Fractor")).toEqual(["blue", "xfractor"]);
  });

  it("'Blue Xfractor' → ['blue', 'xfractor'] (smoosh equals hyphen)", () => {
    expect(tokenizeParallel("Blue Xfractor")).toEqual(["blue", "xfractor"]);
  });

  it("'Blue X Fractor' → ['blue', 'xfractor'] (space equals hyphen)", () => {
    expect(tokenizeParallel("Blue X Fractor")).toEqual(["blue", "xfractor"]);
  });

  it("'BLUE X-FRACTOR' → ['blue', 'xfractor'] (CAPS folds to canonical)", () => {
    expect(tokenizeParallel("BLUE X-FRACTOR")).toEqual(["blue", "xfractor"]);
  });

  it("strict equality: 'Blue X-Fractor' tokens equal 'Blue Xfractor' tokens (the parallel-binding load-bearing case)", () => {
    expect(tokenizeParallel("Blue X-Fractor")).toEqual(tokenizeParallel("Blue Xfractor"));
  });

  it("'Lex-Fractor' is NOT normalized (word-boundary guard)", () => {
    // 'e' before 'x' blocks \b — the pre-replace does not fire.
    // Note: split on hyphen will still produce ["lex", "fractor"]; the
    // assertion is that "lexfractor" does NOT appear.
    const tokens = tokenizeParallel("Lex-Fractor");
    expect(tokens).not.toContain("lexfractor");
  });

  it("'Refractor' is unchanged (cross-family guard)", () => {
    expect(tokenizeParallel("Refractor")).toEqual(["refractor"]);
  });

  it("'Superfractor' is unchanged (no X-Fractor regex hit)", () => {
    expect(tokenizeParallel("Superfractor")).toEqual(["superfractor"]);
  });

  it("'Blue Refractor' is unchanged (Refractor family untouched)", () => {
    expect(tokenizeParallel("Blue Refractor")).toEqual(["blue", "refractor"]);
  });
});
