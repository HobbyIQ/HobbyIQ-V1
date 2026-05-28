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
import type { CardsightPricingResponse } from "../src/services/compiq/cardsight.client.js";

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
