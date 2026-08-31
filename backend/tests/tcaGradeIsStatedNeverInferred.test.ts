// CF-GRADE-IS-STATED-NEVER-INFERRED (Drew, 2026-08-31: "there is an issue
// TCA-ebay. I am seeing no grades and listed as raw when they are graded").
//
// Pins the direction rule for TCA/vendor ingest grade extraction:
//
//   a title that STATES a grade  -> that grade, via the shared parser
//   a title that states NONE     -> RAW, always
//
// The fixtures are LIVE tca-ebay titles measured from prod sold_comps on
// 2026-08-31 (see backend/scripts/probe-tca-inferred-grades.cjs), so a
// regression here is a regression against real rows, not invented text.
//
// THE EXPENSIVE DIRECTION. Under-calling a grade costs one row in the raw
// pool. Over-calling it moves a raw sale into a graded pool, which corrupts
// BOTH pools at once — the graded tier's FMV is dragged toward the raw price
// and the raw tier loses a real sale. Every ambiguous case below must stay
// raw for that reason.

import { describe, it, expect } from "vitest";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

/** The ingest rule under test, exactly as persistVendorSalesToPool applies it:
 *  the shared parser is the ONLY authority. No price, no inference. */
function ingestGradeOf(title: string): { company: string | null; value: number | null } {
  const g = parseGradeLabel(title);
  return { company: g?.gradeCompany ?? null, value: g?.gradeValue ?? null };
}

describe("TCA ingest: a stated grade is honoured", () => {
  // Live tca-ebay titles whose grade the pool stores correctly today.
  const stated: Array<[string, string, number]> = [
    ["2024 Panini Donruss Optic Michael Penix Jr. Rated Rookie Blue Hyper #279 PSA 10", "PSA", 10],
    ["2020 Bowman Heritage Shohei Ohtani #26 PSA 10", "PSA", 10],
    ["2024 Panini Donruss Downtown Lamar Jackson #1 PSA 8 Baltimore Ravens🔥", "PSA", 8],
    ["1986-87 Fleer - Wayne Cooper #18 PSA 8 Set Break", "PSA", 8],
    ["2024 Prizm Jayden Daniels RC Rookie #347 Commanders PSA 9 Mint", "PSA", 9],
    ["Topps 1993 Street Fighter II Ken #67 Base Set PSA 8 Cert 70504446", "PSA", 8],
  ];

  it.each(stated)("%s -> %s %d", (title, company, value) => {
    expect(ingestGradeOf(title)).toEqual({ company, value });
  });

  it("reads the grade beside a card number that could be mistaken for one", () => {
    // "#347" must not become the grade; "PSA 9" must.
    expect(ingestGradeOf(
      "Jayden Daniels 2024 Panini Prizm #347 Rookie RC PSA 9 Washington Commanders",
    )).toEqual({ company: "PSA", value: 9 });
  });
});

describe("TCA ingest: a title with NO stated grade stays raw", () => {
  // THE FIVE LIVE EXAMPLES. Every one was stored WITH a grade by the retired
  // price-band resolver despite naming no grader at all — the bug this fixes.
  const priceInferredVictims: Array<[string, string]> = [
    ["2021 Topps Chrome - Shohei Ohtani #159 Refractor", "was stored PSA 9"],
    ["1950 Bowman - Bob Feller #6", "was stored SGC 3"],
    ["2024 Bowman Chrome Seaver King 1st Purple Auto /250 Nationals #CPA-SK", "was stored PSA 10"],
    ["1996-97 Topps Kobe Bryant Rookie RC #138 Lakers", "was stored BGS 8.5"],
    ["2024 Mike Sirota Bowman Draft Chrome 1st Auto #CPA-MS - Los Angeles Dodgers", "was stored PSA 9"],
  ];

  it.each(priceInferredVictims)("%s stays raw (%s)", (title) => {
    expect(ingestGradeOf(title)).toEqual({ company: null, value: null });
  });
});

describe("TCA ingest: adversarial non-grades never up-grade", () => {
  // A bare number is a card number, a print run, a year — never a grade.
  const adversarial: string[] = [
    "2024 Bowman Chrome Jackson Holliday #BCP-10",          // "10" is the card number
    "2023 Topps Chrome Refractor /10 Gold",                  // "/10" is a print run
    "1989 Upper Deck Ken Griffey Jr #1 Rookie",              // bare "#1"
    "2024 Panini Prizm Silver PSA ready gem mint candidate", // "PSA ready" is a claim, not a slab
    "Lot of 10 - 2024 Topps Series 1 Baseball Cards",        // lot listing
    "2021 Topps Chrome Sapphire #100 Wander Franco",         // "#100" is not a 10
    "2024 Bowman 1st Chrome Auto /499 Refractor",            // print run only
    "Ready for PSA grading - 2023 Bowman Chrome Prospect",   // pre-grading claim
    "2022 Topps Update Aaron Judge #US1 Home Run 62",        // trailing stat number
  ];

  it.each(adversarial)("%s stays raw", (title) => {
    expect(ingestGradeOf(title)).toEqual({ company: null, value: null });
  });

  it("a grader named without a grade does not manufacture a value", () => {
    // No numeric tier stated and no AUTH token -> nothing to store.
    const g = parseGradeLabel("2024 Bowman Chrome Prospect Auto - PSA submission");
    expect(g?.gradeValue ?? null).not.toBe(10);
  });
});

describe("CF-THE-GRADER-WITH-THE-NUMBER-WINS: a second grader is not the slab", () => {
  // Live tca-ebay titles. A title may name a second grader as a comparison, a
  // cross-over pitch or a regrade question. The holder is the grader carrying
  // the NUMBER — picking by token order instead attributed all of these to PSA
  // and, finding no value beside it, returned null for the whole title.
  const twoGraders: Array<[string, string, number]> = [
    ["1968 TOPPS #230 PETE ROSE  SGC 6 Bright and Sharp!  Reds Not PSA or BVG", "SGC", 6],
    ["Kylian Mbappe | 2020-21 Topps Now C.L #041 | SGC 10 not PSA", "SGC", 10],
    ["Shohei Ohtani 2018 Topps #700 Rookie BGS 9.5 w/2x10 subs PSA Regrade?", "BGS", 9.5],
    ["2024 Topps 50/50: Shohei Ohtani - Shohei Ohtani #75 CGC 10  PSA Crossover 10", "CGC", 10],
    ["Topps 2024 50/50 Shohei Ohtani #67 Dodgers CGC  10 Graded psa", "CGC", 10],
    ["2021 Panini Chronicles Elite PSA  #29 Isaac Paredes RC Rookie SGC  10 Gem Mint", "SGC", 10],
  ];

  it.each(twoGraders)("%s -> %s %s", (title, company, value) => {
    expect(ingestGradeOf(title)).toEqual({ company, value });
  });

  it("still prefers list order when NEITHER grader carries a value", () => {
    // No evidence to distinguish them -> previous behaviour is preserved.
    const g = parseGradeLabel("2024 Bowman Chrome - PSA or BGS submission pending");
    expect(g).toBeNull();
  });

  it("a single grader with a value is unaffected", () => {
    expect(ingestGradeOf("2024 Panini Prizm #347 PSA 9")).toEqual({ company: "PSA", value: 9 });
  });
});

describe("TCA ingest: authenticated slabs are not raw and not a numeric tier", () => {
  // Live tca-ebay titles. gradeValue 0 keeps them out of BOTH the raw bucket
  // and every numeric tier — see CF-AUTHENTIC-BUCKET in gradeParser.ts.
  const authentic: Array<[string, string]> = [
    ["1964 Topps Baseball #125 Pete Rose SGC Authentic", "SGC"],
    ["Topps 1957 Mickey Mantle / Yogi Berra #407 Yankees Power Hitters SGC Authentic", "SGC"],
    ["1984 Topps Traded Dwight Gooden Rookie Autograph RC #42T BGS Authentic Auto", "BGS"],
  ];

  it.each(authentic)("%s -> %s AUTH (value 0, isAuthentic)", (title, company) => {
    const g = parseGradeLabel(title);
    expect(g?.gradeCompany).toBe(company);
    expect(g?.gradeValue).toBe(0);
    expect(g?.isAuthentic).toBe(true);
  });

  it("'SP Authentic' is a product line, not an authentication", () => {
    // No grading company present -> the word alone must not claim the bucket.
    const g = parseGradeLabel("2001 SP Authentic Baseball Albert Pujols #12 Rookie");
    expect(g?.isAuthentic ?? false).toBe(false);
  });
});
