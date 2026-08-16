// CF-AUTHENTIC-BUCKET (Drew, 2026-08-15: "Add in CGC Auth as a grade, it is on
// the ohtani 2018 bowman chrome and messing with comps" → "we need a new
// bucket for Auth for all grading companies so vintage cards fall in there
// too").
//
// An authenticated-but-ungraded slab is neither raw nor a numeric tier. It is
// common on vintage and on trimmed/altered cards, and it trades well BELOW the
// same card raw.
//
// Observed on 2018 Bowman Chrome Ohtani #1: two "CGC AUTH" sales at $1,680 and
// $1,770 sat in the RAW pool against genuine raw sales at $3,000-3,049,
// dragging the raw median to $2,900 and setting the low. Worse, the parser was
// reading "#1" as the grade and returning CGC 1.
import { describe, it, expect } from "vitest";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

describe("parseGradeLabel — Authentic bucket", () => {
  it.each([
    ["2018 Bowman Chrome Shohei Ohtani ROOKIE #1 CGC AUTH", "CGC"],
    ["1952 Topps Mickey Mantle #311 PSA Authentic", "PSA"],
    ["1909 T206 Honus Wagner SGC AUTH", "SGC"],
    ["2020 Prizm Herbert BGS AUTHENTIC", "BGS"],
    ["1990 Donruss Ken Griffey Jr #365 CGC AUTH", "CGC"],
  ])("%s -> %s Authentic", (title, company) => {
    const r = parseGradeLabel(title);
    expect(r).not.toBeNull();
    expect(r!.gradeCompany).toBe(company);
    expect(r!.isAuthentic).toBe(true);
    // 0 cannot collide with a real grade (0.5-10) and keeps the row out of
    // the raw bucket, which tests `gradeValue !== null`.
    expect(r!.gradeValue).toBe(0);
  });

  // A GRADING COMPANY IS REQUIRED. "SP Authentic" is an Upper Deck PRODUCT,
  // and a dry run over the pool tagged 6,450 rows — mostly "2001 SP Authentic
  // Baseball" — as authenticated slabs on the word alone. Worse than the bug
  // being fixed, so no company means no bucket.
  it.each([
    "2001 SP Authentic Baseball #AR Base",
    "2009 SP Authentic Baseball #93 Base",
    "1955 Topps Roberto Clemente #164 Authentic Altered",
  ])("no grading company -> no bucket: %s", (title) => {
    const r = parseGradeLabel(title);
    expect(r?.isAuthentic ?? false).toBe(false);
  });

  it("the card number is not mistaken for a grade", () => {
    // The bug: "#1" was read as grade 1, so a CGC AUTH landed in the CGC 1
    // tier instead of its own bucket.
    const r = parseGradeLabel("2018 Bowman Chrome Shohei Ohtani ROOKIE #1 CGC AUTH");
    expect(r!.gradeValue).not.toBe(1);
  });

  describe("guardrails", () => {
    it("a numeric grade beside the word means the slab IS graded", () => {
      // "CGC AUTH w/ 10 AUTO GRADE" — AUTH describes the autograph here.
      const r = parseGradeLabel("2015 Bowman Draft #130 Taylor Ward RC CGC AUTH w/ 10 AUTO GRADE");
      expect(r?.isAuthentic ?? false).toBe(false);
    });

    it.each([
      ["2018 Bowman Chrome Ohtani #1 PSA 10", "PSA", 10],
      ["2023 Bowman Chrome CGC 9.5", "CGC", 9.5],
    ])("normal grades are untouched: %s", (title, company, value) => {
      const r = parseGradeLabel(title);
      expect(r!.gradeCompany).toBe(company);
      expect(r!.gradeValue).toBe(value);
      expect(r!.isAuthentic ?? false).toBe(false);
    });

    it.each([
      "2021 Bowman Chrome Tatis Hand Signed Auto",
      "2025 Bowman Chrome Will Richard ROOKIE AUTO #BCA-WI",
      "2018 Bowman Chrome Shohei Ohtani RC Rookie #1 Angels",
    ])("an AUTOGRAPH is not an authentication: %s", (title) => {
      const r = parseGradeLabel(title);
      expect(r?.isAuthentic ?? false).toBe(false);
    });
  });
});
