/**
 * CF-ONE-GRADE-LADDER (Drew, 2026-08-25).
 *
 * The catalog holds 1,462,071 rows asserting PSA 9.5, a grade PSA does not
 * issue. These tests pin the scales so that number can be driven to zero and
 * stay there.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalGradeCompany,
  gradesFor,
  isIssuedGrade,
  isImpossibleGrade,
  isRaw,
  GRADE_COMPANIES,
} from "../src/services/catalog/gradeLadder.service";

describe("PSA has no 9.5", () => {
  it("rejects the grade the catalog has 1.46M of", () => {
    expect(isIssuedGrade("PSA", 9.5)).toBe(false);
    expect(isImpossibleGrade("PSA", 9.5)).toBe(true);
  });

  it("accepts the grades PSA does issue, including the half points below 9", () => {
    for (const g of [1, 1.5, 5.5, 7.5, 8, 8.5, 9, 10]) {
      expect(isIssuedGrade("PSA", g), `PSA ${g}`).toBe(true);
    }
  });

  it("keeps the 9 -> 10 jump, which is the whole point of a PSA 10", () => {
    const psa = gradesFor("PSA")!;
    expect(psa).toContain(9);
    expect(psa).toContain(10);
    expect(psa).not.toContain(9.5);
  });
});

describe("the graders that DO issue 9.5", () => {
  it("accepts 9.5 for Beckett, SGC and CGC", () => {
    for (const co of ["BGS", "SGC", "CGC", "CSG"]) {
      expect(isIssuedGrade(co, 9.5), `${co} 9.5`).toBe(true);
      expect(isImpossibleGrade(co, 9.5), `${co} 9.5`).toBe(false);
    }
  });

  it("BCCG is whole numbers only", () => {
    expect(isIssuedGrade("BCCG", 9)).toBe(true);
    expect(isIssuedGrade("BCCG", 9.5)).toBe(false);
  });
});

describe("company names", () => {
  it("folds the two spellings of one grader", () => {
    // 6 rows say MINT GRADING SERVICE, 3 say MNT GRADING. One company.
    expect(canonicalGradeCompany("MINT GRADING SERVICE"))
      .toBe(canonicalGradeCompany("MNT GRADING"));
  });

  it("canonicalises case and spacing", () => {
    expect(canonicalGradeCompany("psa")).toBe("PSA");
    expect(canonicalGradeCompany("  Beckett  Grading   Services ")).toBe("BGS");
  });

  it("returns null for text a parser mistook for a grader", () => {
    // One row each in card_catalog. Unknown, not invalid.
    expect(canonicalGradeCompany("RARE EDITION")).toBeNull();
    expect(canonicalGradeCompany("THE FINAL AUTHORITY")).toBeNull();
  });
});

describe("unknown companies are never called impossible", () => {
  // This is what makes isImpossibleGrade safe to use as a delete predicate.
  it("declines to judge a scale it does not assert", () => {
    expect(isIssuedGrade("SOME NEW GRADER", 9.5)).toBe(true);
    expect(isImpossibleGrade("SOME NEW GRADER", 9.5)).toBe(false);
    expect(isImpossibleGrade("RARE EDITION", 4.7)).toBe(false);
  });

  it("only an asserted ladder can produce a false", () => {
    expect(isImpossibleGrade("PSA", 9.5)).toBe(true);
    expect(isImpossibleGrade(null, 9.5)).toBe(false);
    expect(isImpossibleGrade(undefined, 9.5)).toBe(false);
  });
});

describe("ungraded", () => {
  it("reads both representations of not-graded as raw", () => {
    // 22,485,001 rows say undefined; 1,567,312 say null. Same meaning.
    expect(isRaw(undefined, undefined)).toBe(true);
    expect(isRaw(null, null)).toBe(true);
    expect(isRaw(null, undefined)).toBe(true);
  });

  it("a graded row is not raw", () => {
    expect(isRaw("PSA", 10)).toBe(false);
  });

  it("a missing grade VALUE on a known company is not a valid grade", () => {
    expect(isIssuedGrade("PSA", null)).toBe(false);
    // ...but it is not "impossible" either -- it is incomplete, and deleting on
    // that basis would remove rows whose grade simply was not captured.
    expect(isImpossibleGrade("PSA", null)).toBe(false);
  });
});

describe("the ladder set itself", () => {
  it("asserts a scale for every company it names", () => {
    for (const co of GRADE_COMPANIES) {
      const l = gradesFor(co);
      expect(l, co).toBeTruthy();
      expect(l!.length, co).toBeGreaterThan(0);
      expect(l, co).toContain(10);
    }
  });

  it("no ladder contains a grade above 10 or below 1", () => {
    for (const co of GRADE_COMPANIES) {
      for (const g of gradesFor(co)!) {
        expect(g, `${co} ${g}`).toBeGreaterThanOrEqual(1);
        expect(g, `${co} ${g}`).toBeLessThanOrEqual(10);
      }
    }
  });
});
