// CF-AUTOPRICE-GRADE-CONTRACT — parseGradeLabel tests.
// Covers PSA / BGS / SGC / CGC / CSG / HGA tokenization, decimal grades,
// PSA-10 descriptor variants, raw/ungraded null returns, and unparseable
// fallback to null (surfaced for manual review by the backfill script).

import { describe, it, expect } from "vitest";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

describe("parseGradeLabel — clean canonical inputs", () => {
  it("PSA 10", () => {
    expect(parseGradeLabel("PSA 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("PSA10 (no space)", () => {
    expect(parseGradeLabel("PSA10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("psa 9 (lowercase)", () => {
    expect(parseGradeLabel("psa 9")).toEqual({ gradeCompany: "PSA", gradeValue: 9 });
  });
  it("PSA 8", () => {
    expect(parseGradeLabel("PSA 8")).toEqual({ gradeCompany: "PSA", gradeValue: 8 });
  });
  it("BGS 9.5 (decimal)", () => {
    expect(parseGradeLabel("BGS 9.5")).toEqual({ gradeCompany: "BGS", gradeValue: 9.5 });
  });
  it("BGS9.5 (no space)", () => {
    expect(parseGradeLabel("BGS9.5")).toEqual({ gradeCompany: "BGS", gradeValue: 9.5 });
  });
  it("SGC 9", () => {
    expect(parseGradeLabel("SGC 9")).toEqual({ gradeCompany: "SGC", gradeValue: 9 });
  });
  it("CGC 9", () => {
    expect(parseGradeLabel("CGC 9")).toEqual({ gradeCompany: "CGC", gradeValue: 9 });
  });
  it("CSG 8.5", () => {
    expect(parseGradeLabel("CSG 8.5")).toEqual({ gradeCompany: "CSG", gradeValue: 8.5 });
  });
  it("HGA 9.5", () => {
    expect(parseGradeLabel("HGA 9.5")).toEqual({ gradeCompany: "HGA", gradeValue: 9.5 });
  });
});

describe("parseGradeLabel — PSA-10 descriptor vernacular", () => {
  it("GEM MT 10 → PSA 10 (Maddux Tiffany reference case)", () => {
    expect(parseGradeLabel("GEM MT 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("Gem Mt 10 (mixed case)", () => {
    expect(parseGradeLabel("Gem Mt 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("GEM-MT 10 (hyphenated)", () => {
    expect(parseGradeLabel("GEM-MT 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("GEM MINT 10", () => {
    expect(parseGradeLabel("GEM MINT 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("GEM MT alone (no numeric) → PSA 10 inferred (top grade convention)", () => {
    expect(parseGradeLabel("GEM MT")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("PRISTINE → PSA 10", () => {
    expect(parseGradeLabel("PRISTINE")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
});

describe("parseGradeLabel — raw/ungraded → null", () => {
  it("empty string → null", () => {
    expect(parseGradeLabel("")).toBeNull();
  });
  it("whitespace-only string → null", () => {
    expect(parseGradeLabel("   ")).toBeNull();
  });
  it("null input → null", () => {
    expect(parseGradeLabel(null)).toBeNull();
  });
  it("undefined input → null", () => {
    expect(parseGradeLabel(undefined)).toBeNull();
  });
  it('"Raw" → null', () => {
    expect(parseGradeLabel("Raw")).toBeNull();
  });
  it('"raw" (lowercase) → null', () => {
    expect(parseGradeLabel("raw")).toBeNull();
  });
  it('"Ungraded" → null', () => {
    expect(parseGradeLabel("Ungraded")).toBeNull();
  });
  it('"none" → null', () => {
    expect(parseGradeLabel("none")).toBeNull();
  });
});

describe("parseGradeLabel — unparseable / ambiguous → null (surfaced for review)", () => {
  it("number alone, no company → null (operator must specify company)", () => {
    expect(parseGradeLabel("10")).toBeNull();
  });
  it("number alone with decimal → null", () => {
    expect(parseGradeLabel("9.5")).toBeNull();
  });
  it("garbage string → null", () => {
    expect(parseGradeLabel("xyz123")).toBeNull();
  });
  it("invalid grade value (>10) → null", () => {
    // 15 isn't a real PSA grade — surface for review rather than store nonsense.
    expect(parseGradeLabel("PSA 15")).toBeNull();
  });
  it("invalid grade value (0 / negative) → null", () => {
    expect(parseGradeLabel("PSA 0")).toBeNull();
  });
});

describe("parseGradeLabel — whitespace + leading/trailing tolerance", () => {
  it("leading whitespace", () => {
    expect(parseGradeLabel("  PSA 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("trailing whitespace", () => {
    expect(parseGradeLabel("PSA 10  ")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("internal whitespace tolerated", () => {
    expect(parseGradeLabel("PSA    9")).toEqual({ gradeCompany: "PSA", gradeValue: 9 });
  });
});

describe("parseGradeLabel — common contaminated formats", () => {
  it("Label with grade-prefix slab-stamp style (BGS 9.5 with subscores would just be 9.5)", () => {
    expect(parseGradeLabel("BGS 9.5")).toEqual({ gradeCompany: "BGS", gradeValue: 9.5 });
  });
  it("HGA 9 (less common company still recognized)", () => {
    expect(parseGradeLabel("HGA 9")).toEqual({ gradeCompany: "HGA", gradeValue: 9 });
  });
});

describe("parseGradeLabel — PSA descriptor + numeric (iOS card-scan labels)", () => {
  // PSA slabs print descriptor word alongside numeric grade. iOS card-
  // scan captures the descriptor; parser must recognize the pattern.
  it("MINT 9 → PSA 9", () => {
    expect(parseGradeLabel("MINT 9")).toEqual({ gradeCompany: "PSA", gradeValue: 9 });
  });
  it("MINT 10 → PSA 10", () => {
    expect(parseGradeLabel("MINT 10")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("NM-MT 8 → PSA 8 (Bobby Cox / John Gil reference cases)", () => {
    expect(parseGradeLabel("NM-MT 8")).toEqual({ gradeCompany: "PSA", gradeValue: 8 });
  });
  it("NM MT 8 (space variant)", () => {
    expect(parseGradeLabel("NM MT 8")).toEqual({ gradeCompany: "PSA", gradeValue: 8 });
  });
  it("NM 7 → PSA 7", () => {
    expect(parseGradeLabel("NM 7")).toEqual({ gradeCompany: "PSA", gradeValue: 7 });
  });
  it("EX-MT 6 → PSA 6", () => {
    expect(parseGradeLabel("EX-MT 6")).toEqual({ gradeCompany: "PSA", gradeValue: 6 });
  });
  it("EX 5 → PSA 5", () => {
    expect(parseGradeLabel("EX 5")).toEqual({ gradeCompany: "PSA", gradeValue: 5 });
  });
  it("VG-EX 4 → PSA 4", () => {
    expect(parseGradeLabel("VG-EX 4")).toEqual({ gradeCompany: "PSA", gradeValue: 4 });
  });
  it("VG 3 → PSA 3", () => {
    expect(parseGradeLabel("VG 3")).toEqual({ gradeCompany: "PSA", gradeValue: 3 });
  });
  it("GOOD 2 → PSA 2", () => {
    expect(parseGradeLabel("GOOD 2")).toEqual({ gradeCompany: "PSA", gradeValue: 2 });
  });
  it("POOR 1 → PSA 1", () => {
    expect(parseGradeLabel("POOR 1")).toEqual({ gradeCompany: "PSA", gradeValue: 1 });
  });

  it("explicit BGS company beats descriptor inference", () => {
    // "BGS MINT 9" → BGS 9, not PSA 9 (explicit company wins)
    expect(parseGradeLabel("BGS MINT 9")).toEqual({ gradeCompany: "BGS", gradeValue: 9 });
  });
});
