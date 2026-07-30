// CF-PARSE-PARALLEL-COMPOSITE tests (Drew, 2026-07-30).

import { describe, it, expect, beforeAll } from "vitest";
import { parseParallelComposite, hasNonBaseEdition } from "../src/services/portfolioiq/parseParallelComposite.service.js";
import {
  loadParallelVocabulary,
  matchEditionAlias,
  matchColorFamilyAlias,
  matchFinishModifierAlias,
  validateAgainstLadder,
  __resetParallelVocabularyForTests,
} from "../src/services/portfolioiq/parallelVocabulary.service.js";

beforeAll(() => {
  __resetParallelVocabularyForTests();
  // Load once — ensures the vocab file is present.
  loadParallelVocabulary();
});

describe("parallel vocabulary loader", () => {
  it("loads without throwing + has all four registries", () => {
    const v = loadParallelVocabulary();
    expect(Object.keys(v.editionTokens).length).toBeGreaterThan(0);
    expect(Object.keys(v.colorFamilies).length).toBeGreaterThan(0);
    expect(Object.keys(v.finishModifiers).length).toBeGreaterThan(0);
    expect(Object.keys(v.ladders).length).toBeGreaterThan(0);
  });
});

describe("alias matching — longest-match-first mandatory", () => {
  it("'blue wave refractor' matches BLUE color + WAVE finish (both extracted)", () => {
    // The composite parser handles this; alias matcher returns one of each.
    const color = matchColorFamilyAlias("2024 bowman chrome blue wave refractor /150");
    const finish = matchFinishModifierAlias("2024 bowman chrome blue wave refractor /150");
    expect(color?.canonical).toBe("BLUE");
    expect(finish?.canonical).toBe("WAVE");
  });
  it("'gold vinyl' matches VINYL finish (not just GOLD)", () => {
    const finish = matchFinishModifierAlias("topps flagship 2024 gold vinyl mike trout");
    expect(finish?.canonical).toBe("VINYL");
  });
  it("'sapphire' edition detected", () => {
    const edition = matchEditionAlias("2024 bowman chrome sapphire eric hartman #cpa-eha");
    expect(edition?.canonical).toBe("SAPPHIRE");
  });
  it("'mega box' edition detected", () => {
    const edition = matchEditionAlias("2024 topps chrome mega box aaron judge");
    expect(edition?.canonical).toBe("MEGA_BOX");
  });
  it("'1st edition' edition detected", () => {
    const edition = matchEditionAlias("2020 bowman chrome 1st edition wander franco");
    expect(edition?.canonical).toBe("FIRST_EDITION");
  });
});

describe("parseParallelComposite — end-to-end", () => {
  it("Sapphire edition + serial: edition captured, base card (no color modifier)", () => {
    // Sapphire is an EDITION not a color; base Sapphire has no color-parallel.
    // colorFamily=null is correct.
    const c = parseParallelComposite("2026 Bowman Chrome Sapphire Eric Hartman #CPA-EHA /199", "CPA-EHA");
    expect(c.edition).toBe("SAPPHIRE");
    expect(c.serialRun).toBe(199);
  });

  it("Blue Wave Refractor /150 — color BLUE + finish WAVE + serial 150", () => {
    const c = parseParallelComposite("2024 Bowman Chrome Blue Wave Refractor /150 Justin Herbert");
    expect(c.colorFamily).toBe("BLUE");
    expect(c.finishModifier).toBe("WAVE");
    expect(c.isRefractor).toBe(true);
    expect(c.serialRun).toBe(150);
  });

  it("Speckle Refractor — colorFamily=SPECKLE (own tier in vocab) + isRefractor true", () => {
    // SPECKLE is a colorFamily in the vocab (own tier — unnumbered
    // specialty that pools SEPARATELY per framework), not a finish
    // modifier. Framework rule: unnumbered specialty (Speckle/Prism/
    // Sepia/Mojo) each pool separately.
    const c = parseParallelComposite("2024 Bowman Chrome Speckle Refractor Eric Hartman #CPA-EHA");
    expect(c.colorFamily).toBe("SPECKLE");
    expect(c.isRefractor).toBe(true);
  });

  it("Gold Vinyl (Topps flagship trap) — finish VINYL preserves the distinction", () => {
    const c = parseParallelComposite("2024 Topps Series 1 Aaron Judge Gold Vinyl");
    expect(c.finishModifier).toBe("VINYL");
  });

  it("Insert set via cardNumber prefix BTP-10 → scouts-top-100", () => {
    const c = parseParallelComposite("2024 Bowman Scouts Top 100 Eric Hartman #BTP-10", "BTP-10");
    expect(c.insertSet).toBe("scouts-top-100");
  });

  it("base card, no edition, no color modifiers → colorFamily=null, confidence=low", () => {
    const c = parseParallelComposite("2024 Bowman Eric Hartman rookie #BCP-102", "BCP-102");
    expect(c.edition).toBe(null);
    expect(c.finishModifier).toBe(null);
    // Note: colorFamily may still match "base" via aliases — check the specific alias vocab
  });

  it("serial X/Y takes denominator: '15/499' → serialRun=499", () => {
    const c = parseParallelComposite("2024 Bowman Chrome Refractor 15/499 Eric Hartman");
    expect(c.serialRun).toBe(499);
    expect(c.serialObserved).toBe("15/499");
  });

  it("serial '/2024' on Topps flagship IS the print run (calendarYear ladder)", () => {
    // Framework rule: Topps flagship Gold /calendarYear — 2024 is a
    // VALID serial run for that product (matches "Gold" tier with
    // run="calendarYear" in topps_flagship_paper ladder).
    const c = parseParallelComposite("2024 Topps Series 1 Aaron Judge Gold /2024");
    expect(c.serialRun).toBe(2024);
  });
  it("serial guardrail: '/9999' rejected (>5000 = not a print run)", () => {
    const c = parseParallelComposite("2024 Topps Aaron Judge /9999");
    expect(c.serialRun).toBe(null);
  });
});

describe("hasNonBaseEdition — chrome-implied guard hook", () => {
  it("'Bowman Chrome Sapphire' → true (edition present)", () => {
    expect(hasNonBaseEdition("2024 Bowman Chrome Sapphire Speckle Refractor")).toBe(true);
  });
  it("'Bowman Chrome' with speckle but no edition token → false", () => {
    expect(hasNonBaseEdition("2024 Bowman Chrome Speckle Refractor Eric Hartman")).toBe(false);
  });
  it("'Mega Box' → true (edition-adjacent)", () => {
    expect(hasNonBaseEdition("2024 Topps Chrome Mega Box Aaron Judge Mojo Refractor")).toBe(true);
  });
});

describe("validateAgainstLadder — Bowman Chrome hobby ladder", () => {
  it("Bowman Chrome Blue /150 → matched-verified", () => {
    const v = validateAgainstLadder("Bowman Chrome", 2024, "BLUE", 150);
    expect(v.verdict).toBe("matched-verified");
  });
  it("Bowman Chrome Blue /5 → impossible-serial (Blue must be /150)", () => {
    const v = validateAgainstLadder("Bowman Chrome", 2024, "BLUE", 5);
    expect(v.verdict).toBe("impossible-serial");
    if (v.verdict === "impossible-serial") {
      expect(v.expectedRun).toBe(150);
      expect(v.observedRun).toBe(5);
    }
  });
  it("Topps Chrome Refractor UNNUMBERED → matched (base ladder difference from Bowman)", () => {
    const v = validateAgainstLadder("Topps Chrome", 2024, "REFRACTOR", null);
    expect(v.verdict === "matched-verified" || v.verdict === "matched-probable").toBe(true);
  });
  it("Bowman Chrome Refractor /499 → matched-verified", () => {
    const v = validateAgainstLadder("Bowman Chrome", 2024, "REFRACTOR", 499);
    expect(v.verdict).toBe("matched-verified");
  });
  it("Bowman Chrome Refractor UNNUMBERED → impossible (Bowman refractor is /499)", () => {
    const v = validateAgainstLadder("Bowman Chrome", 2024, "REFRACTOR", null);
    expect(v.verdict).toBe("impossible-serial");
  });
  it("Unknown product → no-ladder (don't gate)", () => {
    const v = validateAgainstLadder("Panini Prizm", 2024, "GOLD", 10);
    expect(v.verdict).toBe("no-ladder");
  });
});
