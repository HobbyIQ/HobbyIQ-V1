// CF-GOLD-LABEL-IS-NOT-FLAGSHIP-TOPPS + CF-BOWMAN-DRAFT-IS-ITS-OWN-FAMILY
// (2026-09-01). Two more instances of the CF-OPTIC-BEFORE-DONRUSS shape: a
// specific product whose name CONTAINS a generic brand token, tested after
// that generic token, and therefore silently resolved to the generic
// SUPERSET cell.
//
//   classifyFamily("2017 Topps Gold Label") -> "topps"   (was)
//   classifyFamily("Bowman Draft")          -> "bowman"  (was)
//
// Both were found while auditing four flagged holdings for user-199fcbc9:
// a 2017 Gold Label Class 1 Judge PSA 9 and a 2024 Bowman Draft CPA auto
// PSA 9 were drawing multipliers calibrated on flagship paper Topps and
// paper Bowman respectively.
//
// Why the cells are genuinely different, not a rounding difference:
// grade-calibrate.mjs builds each family with an INDEPENDENT
// CONTAINS(LOWER(card_set), token) query, so the generic token's cell is a
// strict superset. "Topps" matches every "Topps Gold Label" row plus tens of
// thousands of paper commons; "Bowman" matches every "Bowman Draft" row plus
// the paper flagship. Gold Label is premium chrome stock with serial-numbered
// Class tiers and Bowman Draft is chrome-fronted with CPA autos as its
// headline cards — neither carries the paper product's grade curve.
//
// EMPIRICAL-ONLY DOCTRINE. Neither family is a hand-written multiplier. Both
// were measured in sold_comps BEFORE being added, counting identities that
// carry BOTH a raw and a graded sale (the matched-pair basis the calibration
// script needs):
//   topps-gold-label  219 identities; PSA 9 n=476, PSA 10 n=262, PSA 8 n=190
//   bowman-draft     6378 identities; PSA 10 n=23884, PSA 9 n=14777
// The weekly Grade Calibration Refresh populates the cells from that data.
// Until it runs, lookupGradeRatioByTier falls through to the "other" family —
// the honest answer for an uncalibrated cell, and still better than silently
// reusing a wrong-product number.
//
// These tests pin ORDERING, not numbers. They mock the data module so the
// weekly refresh regenerating the real file can never turn them red.

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

describe("classifyFamily: Gold Label is tested before Topps", () => {
  beforeEach(() => vi.resetModules());

  it("classifies every spelling of Gold Label to its own family", async () => {
    const { classifyFamily } = await loadConfig();
    const gl = "topps-gold-label";
    expect(classifyFamily("2017 Topps Gold Label")).toBe(gl);
    expect(classifyFamily("topps-gold-label")).toBe(gl);
    expect(classifyFamily("Topps Gold Label")).toBe(gl);
    expect(classifyFamily("Gold Label")).toBe(gl);
    // The holding that surfaced this: setName and slug setKey must agree.
    expect(classifyFamily("2017 Topps Gold Label")).toBe(classifyFamily("topps-gold-label"));
  });

  it("keeps Gold Label OFF the flagship paper-Topps cell", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("2017 Topps Gold Label")).not.toBe(classifyFamily("2017 Topps"));
  });

  it("leaves flagship Topps and the other Topps sub-brands untouched", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("2024 Topps")).toBe("topps");
    expect(classifyFamily("topps")).toBe("topps");
    expect(classifyFamily("2017 Topps Series One")).toBe("topps");
    // The specific-before-generic siblings that already worked.
    expect(classifyFamily("Topps Chrome")).toBe("topps-chrome");
    expect(classifyFamily("Topps Chrome Update")).toBe("topps-chrome-update");
    expect(classifyFamily("Topps Heritage")).toBe("topps-heritage");
    expect(classifyFamily("Topps Stadium Club")).toBe("topps-stadium-club");
    expect(classifyFamily("Topps Finest")).toBe("topps-finest");
    expect(classifyFamily("Topps Pristine")).toBe("topps-pristine");
  });
});

describe("classifyFamily: Bowman Draft is tested before Bowman", () => {
  beforeEach(() => vi.resetModules());

  it("classifies every spelling of Bowman Draft to its own family", async () => {
    const { classifyFamily } = await loadConfig();
    const bd = "bowman-draft";
    expect(classifyFamily("Bowman Draft")).toBe(bd);
    expect(classifyFamily("bowman-draft")).toBe(bd);
    expect(classifyFamily("2024 Bowman Draft")).toBe(bd);
    expect(classifyFamily("2024 Bowman Draft Baseball")).toBe(bd);
    // The holding that surfaced this: setName and slug setKey must agree.
    expect(classifyFamily("Bowman Draft")).toBe(classifyFamily("bowman-draft"));
  });

  it("keeps Bowman Draft OFF the paper-Bowman cell", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("Bowman Draft")).not.toBe(classifyFamily("2024 Bowman"));
  });

  it("still sends Bowman Chrome Draft to the chrome-draft family", async () => {
    const { classifyFamily } = await loadConfig();
    // bowman-chrome-draft is MORE specific than bowman-draft and is tested
    // first; adding the bowman-draft rule must not steal its inputs.
    expect(classifyFamily("2025 Bowman Draft Chrome")).toBe("bowman-chrome-draft");
    expect(classifyFamily("Bowman Chrome Draft")).toBe("bowman-chrome-draft");
    expect(classifyFamily("bowman-chrome-draft")).toBe("bowman-chrome-draft");
    expect(classifyFamily("2005 Bowman Chrome Draft Picks & Prospects")).toBe("bowman-chrome-draft");
  });

  it("leaves flagship Bowman and Bowman Chrome untouched", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("2024 Bowman")).toBe("bowman");
    expect(classifyFamily("bowman")).toBe("bowman");
    expect(classifyFamily("2026 Bowman")).toBe("bowman");
    expect(classifyFamily("2024 Bowman Chrome")).toBe("bowman-chrome");
    expect(classifyFamily("bowman-chrome")).toBe("bowman-chrome");
    expect(classifyFamily("Bowman Sterling")).toBe("bowman-sterling");
    // CPA rerouting (CF-CLASSIFY-CPA-AS-BOWMAN-CHROME) is unchanged.
    expect(classifyFamily("chrome prospects autographs")).toBe("bowman-chrome");
  });
});

describe("classifyFamily: the generic catch-alls still behave", () => {
  beforeEach(() => vi.resetModules());

  it("returns other for an unrecognized set and for nullish input", async () => {
    const { classifyFamily } = await loadConfig();
    expect(classifyFamily("2025 Random Sportscard Corp Emblem")).toBe("other");
    expect(classifyFamily(null)).toBe("other");
    expect(classifyFamily(undefined)).toBe("other");
  });

  it("keeps Pokemon ahead of every sports brand", async () => {
    const { classifyFamily } = await loadConfig();
    // A Pokemon set whose name contains "gold" must not reach the new rule.
    expect(classifyFamily("Pokemon Base Set")).toBe("pokemon-base");
    expect(classifyFamily("2021 Pokemon Evolving Skies")).toBe("pokemon-evolving-skies");
  });
});

describe("the classifier and the calibration generator name the same cells", () => {
  beforeEach(() => vi.resetModules());

  // The two files are a PAIR: scripts/grade-calibrate.mjs BASELINE_FAMILIES
  // decides which cells exist, classifyFamily decides which cell a card
  // reaches. A family added to one and not the other is a silent
  // fall-through, which is the bug class this whole file guards.
  it("declares both new families in grade-calibrate.mjs BASELINE_FAMILIES", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const pathMod = await import("node:path");
    const here = pathMod.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(pathMod.join(here, "..", "scripts", "grade-calibrate.mjs"), "utf8");
    expect(src).toContain('{ family: "topps-gold-label", token: "Gold Label" }');
    expect(src).toContain('{ family: "bowman-draft", token: "Bowman Draft" }');
  });

  it("orders the generator's tokens specific-before-generic too", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const pathMod = await import("node:path");
    const here = pathMod.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(pathMod.join(here, "..", "scripts", "grade-calibrate.mjs"), "utf8");
    const at = (needle: string) => src.indexOf(needle);
    // Gold Label before the bare Topps token.
    expect(at('{ family: "topps-gold-label"')).toBeGreaterThan(-1);
    expect(at('{ family: "topps-gold-label"')).toBeLessThan(at('{ family: "topps", token: "Topps" }'));
    // Bowman Draft before the bare Bowman token, and after Bowman Chrome
    // Draft (which is more specific still).
    expect(at('{ family: "bowman-draft"')).toBeGreaterThan(-1);
    expect(at('{ family: "bowman-draft"')).toBeLessThan(at('{ family: "bowman", token: "Bowman" }'));
    expect(at('{ family: "bowman-chrome-draft"')).toBeLessThan(at('{ family: "bowman-draft"'));
  });
});
