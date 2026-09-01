// CF-PRISTINE-IS-A-PRODUCT-NOT-A-GRADE (2026-09-01).
//
// THE DEFECT. "Pristine" sat in PSA_10_PATTERNS as a top-grade descriptor. It is
// also the name of a Topps product line, so every "2024 Topps Pristine ..." sale
// whose title stated NO grade was minted as a PSA 10 by the descriptor-only
// fallback in parseGradeLabel — the function ingestGradeFromTitle delegates to,
// and therefore the grade the live vendor ingest write path stamps on the row.
//
// MEASURED MECHANISM (probe against origin/main 7e0087b, before the fix):
//   "2024 Topps Pristine Baseball #131 Base"  -> PSA 10   (phantom)
//   "2024 Topps Pristine Baseball #5 Base"    -> null
// The card number is not what feeds the grade — 131 fails the 0<v<=10 range
// check, leaving detectedValue null so the descriptor-ONLY fallback fires on the
// bare word. "#5" is a valid grade value, so it populates detectedValue and
// suppresses that fallback. The old code therefore returned raw only by the
// accident of a card number happening to look like a grade.
//
// WHY THIS IS THE EXPENSIVE DIRECTION (see tcaGradeIsStatedNeverInferred.ts):
// over-calling a grade corrupts two pools at once — the graded tier's FMV is
// dragged toward a raw price, and the raw tier loses a real sale.
//
// A 16-set-word sweep (Perfect/Gem/Mint/Chrome/Select/Optic/Prizm/Immaculate/
// Flawless/Gold Label/Sterling/Diamond/...) found ONLY "Pristine" collides, so
// the guard is scoped to that word rather than generalized.

import { describe, it, expect } from "vitest";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

/** The grade decision as a comparable tuple. */
function gradeOf(title: string): { company: string | null; value: number | null } {
  const g = parseGradeLabel(title);
  return { company: g?.gradeCompany ?? null, value: g?.gradeValue ?? null };
}

const RAW = { company: null, value: null };

describe("Pristine as a PRODUCT token mints no grade", () => {
  // Product-context titles: the set word sits beside a year and/or a brand and
  // the title names no grader at all. Every one of these was a phantom PSA 10.
  const productContext: string[] = [
    "2024 Topps Pristine Baseball #131 Base",
    "2024 Topps Pristine Baseball Jackson Holliday #131",
    "2023 Topps Pristine Elly De La Cruz #55 Rookie",
    "2024 Topps Pristine Hobby Box Baseball",
    "Topps Pristine",
  ];

  it.each(productContext)("%s -> raw", (title) => {
    expect(gradeOf(title)).toEqual(RAW);
  });

  it("does not depend on the card number looking unlike a grade", () => {
    // THE ACCIDENT, PINNED. Pre-fix, "#131" went phantom while "#5" came back
    // raw purely because 5 is inside the valid grade range. Both must be raw
    // now, for the same reason: the title states no grade.
    expect(gradeOf("2024 Topps Pristine Baseball #131 Base")).toEqual(RAW);
    expect(gradeOf("2024 Topps Pristine Baseball #5 Base")).toEqual(RAW);
    expect(gradeOf("2024 Topps Pristine Baseball #7 Base")).toEqual(RAW);
  });
});

describe("a genuine grade on a Pristine product title still lands", () => {
  // Topps Pristine is a graded-card-heavy line, so real slab grades appear on
  // these titles constantly. The guard must not eat them.
  it("'2024 Topps Pristine Jackson Holliday PSA 10' -> PSA 10", () => {
    expect(gradeOf("2024 Topps Pristine Jackson Holliday PSA 10"))
      .toEqual({ company: "PSA", value: 10 });
  });

  it("a non-10 grade on a Pristine title survives too", () => {
    expect(gradeOf("2024 Topps Pristine Elly De La Cruz #131 BGS 9.5"))
      .toEqual({ company: "BGS", value: 9.5 });
  });

  it("a competing descriptor on a Pristine title still resolves", () => {
    // "Gem Mint" is a grade word that is NOT a product name. The Pristine guard
    // is scoped to the Pristine pattern only and must not suppress it.
    expect(gradeOf("2024 Topps Pristine Baseball #131 Gem Mint"))
      .toEqual({ company: "PSA", value: 10 });
  });
});

describe("grader vocabulary: Pristine is BGS/CGC's LABEL for a ten", () => {
  // BGS and CGC print "Pristine" as the name of the 10 itself. These titles name
  // a company, so the product-context guard never engages.
  it("'CGC Pristine 10 Charizard' -> CGC 10", () => {
    expect(gradeOf("CGC Pristine 10 Charizard")).toEqual({ company: "CGC", value: 10 });
  });

  it("'BGS 10 Pristine' keeps its Black Label elevation", () => {
    expect(parseGradeLabel("BGS 10 Pristine")).toEqual({
      gradeCompany: "BGS", gradeValue: 10, isBlackLabel: true,
    });
  });

  it("'PSA 10 Pristine' -> PSA 10, no Black Label leak", () => {
    expect(parseGradeLabel("PSA 10 Pristine")).toEqual({
      gradeCompany: "PSA", gradeValue: 10,
    });
  });
});

describe("regression pins — behaviour outside the Pristine word is unchanged", () => {
  it("a bare 'PRISTINE' slab label still reads PSA 10", () => {
    // The iOS card-scan input the descriptor fallback exists for. No year, no
    // brand, no product context -> still a grade word. Pinned by
    // gradeParser.test.ts too; asserted here so the guard's boundary is explicit.
    expect(parseGradeLabel("PRISTINE")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });

  it("'GEM MT' alone still reads PSA 10", () => {
    expect(parseGradeLabel("GEM MT")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });

  it("'2023 Panini Prizm #131' -> raw (a non-Pristine product title)", () => {
    expect(gradeOf("2023 Panini Prizm #131")).toEqual(RAW);
  });

  it("#1608 pins: a stated grade is honoured, a stated none stays raw", () => {
    expect(gradeOf("2020 Bowman Heritage Shohei Ohtani #26 PSA 10"))
      .toEqual({ company: "PSA", value: 10 });
    expect(gradeOf("2021 Topps Chrome - Shohei Ohtani #159 Refractor")).toEqual(RAW);
    expect(gradeOf("1996-97 Topps Kobe Bryant Rookie RC #138 Lakers")).toEqual(RAW);
  });
});
