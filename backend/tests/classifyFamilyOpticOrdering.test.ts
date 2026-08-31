// CF-OPTIC-BEFORE-DONRUSS (Drew, 2026-08-31). D31 (#1596) made
// "donruss-optic" the canonical Optic setKey. classifyFamily tested
// s.includes("donruss") BEFORE s.includes("optic"), so the new canonical
// spelling classified to "panini-donruss" and every Optic card would have
// drawn paper-Donruss grade multipliers -- a silent re-route of the ~345k
// Optic pool rows the rename moves.
//
// Why the two cells are genuinely different and not interchangeable:
// grade-calibrate.mjs builds each family with an INDEPENDENT
// CONTAINS(LOWER(c.card_set), @token) query. "Donruss" matches every
// "Donruss Optic" row too, so panini-donruss is a SUPERSET cell (PSA
// n=1426) containing all of panini-optic (PSA n=813) plus ~600 paper rows.
// Chrome-front Optic and paper Donruss carry different grade curves, so
// resolving an Optic card to the blended superset is wrong even though
// the cell is well-populated.
//
// These tests pin ORDERING, not the numbers -- they use a fixture table so
// the weekly "Grade Calibration Refresh" regenerating the real data file
// can never turn them red.

import { describe, it, expect, beforeEach, vi } from "vitest";

async function loadConfig() {
  vi.resetModules();
  vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
    GRADE_CALIBRATION: {},
    GRADE_CALIBRATION_BY_SPORT: {},
    GRADE_MULTIPLIER_BY_VALUE_BAND: { baseline: {}, bySport: {}, bySportFamily: {} },
  }));
  return await import("../src/services/compiq/gradeCalibrationConfig.js");
}

describe("classifyFamily: Optic is tested before Donruss", () => {
  beforeEach(() => vi.resetModules());

  it("classifies the new canonical setKey to the Optic family", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("donruss-optic")).toBe("panini-optic");
  });

  it("agrees across every spelling of the one product", async () => {
    const { classifyFamily } = await loadConfig();
    const optic = classifyFamily("donruss-optic");
    // The D31 rename: pre-rename slug, post-rename slug, the vendor alias
    // and the human strings must all land on one calibration cell.
    expect(classifyFamily("panini-optic")).toBe(optic);
    expect(classifyFamily("panini-donruss-optic")).toBe(optic);
    expect(classifyFamily("Donruss Optic")).toBe(optic);
    expect(classifyFamily("2023 Donruss Optic")).toBe(optic);
    expect(classifyFamily("2024 Panini Donruss Optic Football")).toBe(optic);
    expect(classifyFamily("optic")).toBe(optic);
  });

  it("keeps returning the key GRADE_CALIBRATION is actually keyed by", async () => {
    const { classifyFamily } = await loadConfig();
    // #1596 changed the INPUT spelling (the setKey), not the calibration
    // cell name. The data file still keys this family "panini-optic"; a
    // classifier returning "donruss-optic" would miss every cell and fall
    // through to "other".
    expect(classifyFamily("donruss-optic")).toBe("panini-optic");
    // Guard against the rename later being applied to the data keys without
    // the classifier following: whatever key the REAL data file uses, the
    // classifier must land on it or the lookup silently falls through.
    const realData = await vi.importActual<{
      GRADE_CALIBRATION: Record<string, unknown>;
    }>("../src/services/compiq/gradeCalibrationData.js");
    expect(Object.keys(realData.GRADE_CALIBRATION)).toContain(
      classifyFamily("donruss-optic"),
    );
  });
});

describe("classifyFamily: paper Donruss is unchanged", () => {
  beforeEach(() => vi.resetModules());

  it("still classifies Donruss without Optic to the Donruss family", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("panini-donruss")).toBe("panini-donruss");
    expect(classifyFamily("donruss")).toBe("panini-donruss");
    expect(classifyFamily("Donruss")).toBe("panini-donruss");
    expect(classifyFamily("2023 Donruss")).toBe("panini-donruss");
    expect(classifyFamily("2023 Panini Donruss Baseball")).toBe("panini-donruss");
    expect(classifyFamily("Donruss Rated Rookie")).toBe("panini-donruss");
  });

  it("keeps paper Donruss and Optic on SEPARATE cells", async () => {
    const { classifyFamily } = await loadConfig();
    // The whole point of the fix: these two must not collapse together.
    expect(classifyFamily("donruss-optic")).not.toBe(classifyFamily("panini-donruss"));
  });
});

describe("classifyFamily: the rest of the classifier is untouched", () => {
  beforeEach(() => vi.resetModules());

  // Specific-before-generic pairs that were ALREADY correctly ordered.
  // Pinned so a future re-order (like the one this file fixes) can't
  // regress them in the other direction.
  it("keeps every specific-before-generic pair resolving to the specific family", async () => {
    const { classifyFamily } = await loadConfig();
    const cases: Array<[string, string]> = [
      ["2025 Bowman Draft Chrome", "bowman-chrome-draft"],
      ["2024 Bowman Chrome", "bowman-chrome"],
      ["bowman-chrome", "bowman-chrome"],
      ["Bowman Sterling", "bowman-sterling"],
      ["2024 Bowman", "bowman"],
      ["Topps Chrome Update", "topps-chrome-update"],
      ["Topps Chrome", "topps-chrome"],
      ["topps-chrome", "topps-chrome"],
      ["Topps Update", "topps-update"],
      ["Topps Heritage", "topps-heritage"],
      ["Topps Finest", "topps-finest"],
      ["Topps Stadium Club", "topps-stadium-club"],
      ["2024 Topps", "topps"],
      ["Panini Prizm", "panini-prizm"],
      ["Panini Select", "panini-select"],
      ["Panini Mosaic", "panini-mosaic"],
      ["Playoff Contenders", "panini-contenders"],
      ["National Treasures", "panini-national-treasures"],
      ["Upper Deck", "upper-deck"],
    ];
    for (const [input, expected] of cases) {
      expect({ input, family: classifyFamily(input) }).toEqual({ input, family: expected });
    }
  });

  it("still returns other for an unrecognized set and for nullish input", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("2025 Random Sportscard Corp Emblem")).toBe("other");
    expect(classifyFamily(null)).toBe("other");
    expect(classifyFamily(undefined)).toBe("other");
  });

  it("leaves Pokemon classification ahead of every sports brand", async () => {
    const { classifyFamily } = await loadConfig();
    // The Pokemon block returns before reaching the Panini rules, so
    // moving the optic rule must not have changed its precedence.
    expect(classifyFamily("2021 Pokemon Evolving Skies")).toBe("pokemon-evolving-skies");
    expect(classifyFamily("Pokemon Base Set")).toBe("pokemon-base");
  });

  // Pre-existing collapse, pinned as-is rather than silently inherited.
  // #1596 called this out explicitly: bare "Contenders Optic" reaches the
  // bare optic rule before the bare contenders rule. Hoisting optic above
  // donruss does NOT change this -- it resolved to panini-optic before the
  // change and still does. Re-ordering optic vs contenders is its own lane
  // with its own blast radius (~35 rows on a bare contenders-optic key).
  it("pins the known Contenders Optic / Chronicles Optic collapse unchanged", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("Contenders Optic")).toBe("panini-optic");
    expect(classifyFamily("Chronicles Optic")).toBe("panini-optic");
    // ...while the non-Optic parents keep their own families.
    expect(classifyFamily("Panini Contenders")).toBe("panini-contenders");
    expect(classifyFamily("Panini Chronicles")).toBe("panini-chronicles");
  });
});
