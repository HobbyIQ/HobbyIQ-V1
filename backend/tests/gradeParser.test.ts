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

// ── CF-BGS-BLACK-LABEL-INGEST (PR #495 follow-up) ─────────────────────
// BGS 10 with adjacent "Black Label" / "Pristine" / "BL" tokens elevates
// to isBlackLabel: true so downstream (composeGradeKey → getGraderPremium)
// hits the 9x fallback tier instead of the regular BGS 10 3.5x tier.

describe("parseGradeLabel — BGS 10 Black Label detection", () => {
  it("\"BGS 10 Black Label\" → isBlackLabel: true", () => {
    expect(parseGradeLabel("BGS 10 Black Label")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 10,
      isBlackLabel: true,
    });
  });

  it("\"BGS 10 Pristine\" → isBlackLabel: true (Beckett's other name)", () => {
    expect(parseGradeLabel("BGS 10 Pristine")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 10,
      isBlackLabel: true,
    });
  });

  it("case-insensitive: \"bgs 10 black label\" also flips the bit", () => {
    expect(parseGradeLabel("bgs 10 black label")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 10,
      isBlackLabel: true,
    });
  });

  it("\"BGS 10 BL\" (short form) → isBlackLabel: true", () => {
    expect(parseGradeLabel("BGS 10 BL")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 10,
      isBlackLabel: true,
    });
  });

  it("regular \"BGS 10\" does NOT set isBlackLabel", () => {
    expect(parseGradeLabel("BGS 10")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 10,
    });
  });

  it("\"BGS 9.5 Black Label\" does NOT set isBlackLabel — 10-only tier", () => {
    expect(parseGradeLabel("BGS 9.5 Black Label")).toEqual({
      gradeCompany: "BGS",
      gradeValue: 9.5,
    });
  });

  it("\"PSA 10 Pristine\" does NOT set isBlackLabel — BGS-only tier", () => {
    // Some Cardsight legacy labels use "Pristine" for PSA gem-mint 10s.
    // Our tier is BGS-only; the elevation must not leak.
    expect(parseGradeLabel("PSA 10 Pristine")).toEqual({
      gradeCompany: "PSA",
      gradeValue: 10,
    });
  });
});

// ── composeGradeKey ──────────────────────────────────────────────────
// The canonical grade-key formatter that the routes use to build the
// "COMPANY GRADE" string that downstream selectors + getGraderPremium
// expect. Black Label elevation must ONLY apply to (BGS, 10, true).

describe("parseGradeLabel — PSA qualifier flags (issue #713)", () => {
  it("PSA 9 (OC) → base 9 + qualifier OC (parenthesized)", () => {
    expect(parseGradeLabel("PSA 9 (OC)")).toEqual({
      gradeCompany: "PSA", gradeValue: 9, qualifier: "OC",
    });
  });

  it("PSA 9(OC) → base 9 + qualifier OC (no space)", () => {
    expect(parseGradeLabel("PSA 9(OC)")).toEqual({
      gradeCompany: "PSA", gradeValue: 9, qualifier: "OC",
    });
  });

  it("PSA 9 OC → base 9 + qualifier OC (bare suffix)", () => {
    expect(parseGradeLabel("PSA 9 OC")).toEqual({
      gradeCompany: "PSA", gradeValue: 9, qualifier: "OC",
    });
  });

  it("PSA 8 MK → base 8 + qualifier MK (marks)", () => {
    expect(parseGradeLabel("PSA 8 MK")).toEqual({
      gradeCompany: "PSA", gradeValue: 8, qualifier: "MK",
    });
  });

  it("PSA 7 (ST) → base 7 + qualifier ST (stain)", () => {
    expect(parseGradeLabel("PSA 7 (ST)")).toEqual({
      gradeCompany: "PSA", gradeValue: 7, qualifier: "ST",
    });
  });

  it("PSA 9 (PD) → base 9 + qualifier PD (print defect)", () => {
    expect(parseGradeLabel("PSA 9 (PD)")).toEqual({
      gradeCompany: "PSA", gradeValue: 9, qualifier: "PD",
    });
  });

  it("PSA 8 (MC) → base 8 + qualifier MC (miscut)", () => {
    expect(parseGradeLabel("PSA 8 (MC)")).toEqual({
      gradeCompany: "PSA", gradeValue: 8, qualifier: "MC",
    });
  });

  it("PSA 7 OF → base 7 + qualifier OF (out of focus)", () => {
    expect(parseGradeLabel("PSA 7 OF")).toEqual({
      gradeCompany: "PSA", gradeValue: 7, qualifier: "OF",
    });
  });

  it("case-insensitive: PSA 9 (oc) → base 9 + qualifier OC", () => {
    expect(parseGradeLabel("PSA 9 (oc)")).toEqual({
      gradeCompany: "PSA", gradeValue: 9, qualifier: "OC",
    });
  });

  it("PSA 10 (no qualifier) — qualifier field absent", () => {
    const parsed = parseGradeLabel("PSA 10");
    expect(parsed).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
    expect(parsed?.qualifier).toBeUndefined();
  });

  it("PSA 9 MT → base 9, MT is NOT a qualifier (Mint descriptor)", () => {
    // MT is the PSA MINT descriptor, not a qualifier. Must not be
    // mistaken for a qualifier flag.
    const parsed = parseGradeLabel("PSA 9 MT");
    expect(parsed?.qualifier).toBeUndefined();
    expect(parsed?.gradeCompany).toBe("PSA");
    expect(parsed?.gradeValue).toBe(9);
  });

  it("BGS 9.5 (OC) → does NOT tag qualifier (BGS uses deductions, not qualifiers)", () => {
    // Qualifier flags are PSA-specific. BGS/SGC/CGC use half-point
    // deductions instead. Don't tag OC on non-PSA companies to avoid
    // false-positive on legitimate label text.
    const parsed = parseGradeLabel("BGS 9.5 (OC)");
    expect(parsed?.qualifier).toBeUndefined();
    expect(parsed?.gradeCompany).toBe("BGS");
    expect(parsed?.gradeValue).toBe(9.5);
  });

  it("PSA 9 (XX) → base 9 only, XX is not a valid PSA qualifier", () => {
    // Only OC/MK/ST/PD/MC/OF are recognized qualifier codes. Random
    // 2-letter suffixes should not match.
    const parsed = parseGradeLabel("PSA 9 (XX)");
    expect(parsed?.qualifier).toBeUndefined();
  });
});

import { composeGradeKey } from "../src/services/compiq/compiqEstimate.service.js";

describe("composeGradeKey — canonical grade-key formatting", () => {
  it("(\"BGS\", 10, true) → \"BGS 10 Black Label\"", () => {
    expect(composeGradeKey("BGS", 10, true)).toBe("BGS 10 Black Label");
  });

  it("(\"BGS\", 10, false) → \"BGS 10\"", () => {
    expect(composeGradeKey("BGS", 10, false)).toBe("BGS 10");
  });

  it("(\"BGS\", 10, undefined) → \"BGS 10\"", () => {
    expect(composeGradeKey("BGS", 10)).toBe("BGS 10");
  });

  it("(\"bgs\", \"10\", true) → \"BGS 10 Black Label\" (case + string tolerant)", () => {
    expect(composeGradeKey("bgs", "10", true)).toBe("BGS 10 Black Label");
  });

  it("(\"PSA\", 10, true) → \"PSA 10\" (elevation is BGS-only)", () => {
    expect(composeGradeKey("PSA", 10, true)).toBe("PSA 10");
  });

  it("(\"BGS\", 9.5, true) → \"BGS 9.5\" (elevation is 10-only)", () => {
    expect(composeGradeKey("BGS", 9.5, true)).toBe("BGS 9.5");
  });

  it("missing company or value → \"Raw\"", () => {
    expect(composeGradeKey(null, 10)).toBe("Raw");
    expect(composeGradeKey("BGS", null)).toBe("Raw");
    expect(composeGradeKey(undefined, undefined)).toBe("Raw");
    expect(composeGradeKey("", "")).toBe("Raw");
  });
});
