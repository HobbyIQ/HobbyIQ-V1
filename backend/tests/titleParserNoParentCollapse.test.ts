// CF-FOLD-UP-COLLAPSE-IS-FORBIDDEN (title-parser extension, 2026-09-13).
//
// THE DEFECT. Drew ruled 2026-09-03 that product-family collapse is
// forbidden -- "every pair is a normalizeSetKey fixed point" -- and
// `normalizeSetKey` / `knownSetKeyPatterns` / productSetKeys.ts /
// setkey-reconciliation.json all carry that ruling correctly today. But
// `inferFamilySetKeyFromTitle` (parseTitleIdentity.service.ts), the
// brand-first parser that reads a raw marketplace TITLE rather than a bare
// setName, never got the same qualifier check for four named products:
//
//   "2025 Panini Prizm Deca ..."               -> "Panini Prizm"   (WRONG)
//   "2024 Panini Prizm Draft Picks ..."        -> "Panini Prizm"   (WRONG)
//   "2024 Topps Chrome Update Series ..."      -> "Topps Chrome"   (WRONG)
//   "2023 Topps Chrome Platinum Anniversary .." -> "Topps Chrome"   (WRONG)
//
// The bare `/topps\s+chrome/` and `/\bprizm\b/` catch-alls fired on ANY
// title containing those words and returned the display string for the
// FAMILY before `normalizeSetKey` ever saw the qualifying word ("Update
// Series", "Platinum", "Deca", "Draft Picks") -- a fixed point downstream
// cannot rescue a word this function already discarded. The 2026-09-13
// census clustering caught this live: 114 CONFLICT samples of
// `topps-chrome-platinum -> topps-chrome` alone, against an EXPLICIT
// 2026-09-03 ruling that the pair is distinct -- a regression of an
// already-ruled pair, not a new question.
//
// THE FIX is a qualifier check ahead of each bare catch-all, the same
// pattern this file already uses for Sapphire ("Topps Chrome Sapphire" vs
// "Bowman Chrome Sapphire") and the soccer competition table: most
// specific first, gated on the word the title actually states.
//
// This suite pins (1) the four titles from the census, read end-to-end
// through inferSetKeyFromTitle AND through normalizeSetKey so the fix is
// verified at both seams, and (2) every 2026-09-03 DISTINCT pair as a
// normalizeSetKey fixed point, so no future edit re-opens the collapse
// this ruling forbids -- for either side of the pair.
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("the title parser does not fold a named product up to its flagship", () => {
  it("Panini Prizm Deca keeps its own key", () => {
    const title = "2025 Panini Prizm Deca Football #S-TME Ja'Marr Chase Base";
    expect(inferSetKeyFromTitle(title)).toBe("Panini Prizm Deca");
    expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("panini-prizm-deca");
  });

  it("Panini Prizm Draft Picks keeps its own key", () => {
    const title = "2024 Panini Prizm Draft Picks Football #160 Silver";
    expect(inferSetKeyFromTitle(title)).toBe("Panini Prizm Draft Picks");
    expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("panini-prizm-draft-picks");
  });

  it("Topps Chrome Update Series keeps its own key", () => {
    const title = "2024 Topps Chrome Update Series Baseball #USC50 Base";
    expect(inferSetKeyFromTitle(title)).toBe("Topps Chrome Update Series");
    expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("topps-chrome-update-series");
  });

  it("Topps Chrome Platinum keeps its own key (the already-ruled pair, 114 census samples)", () => {
    const title = "2023 Topps Chrome Platinum Anniversary Baseball #TCPA-1 Base";
    expect(inferSetKeyFromTitle(title)).toBe("Topps Chrome Platinum");
    expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("topps-chrome-platinum");
  });

  it("leaves the bare flagship titles exactly as they were", () => {
    expect(inferSetKeyFromTitle("2024 Topps Chrome Baseball #100 Refractor")).toBe("Topps Chrome");
    expect(inferSetKeyFromTitle("2024 Panini Prizm Basketball #1 Silver")).toBe("Panini Prizm");
  });

  it("does not disturb the Topps Chrome Sapphire qualifier this pattern was modeled on", () => {
    expect(inferSetKeyFromTitle("2024 Topps Chrome Sapphire Baseball #1")).toBe("Topps Chrome Sapphire");
    expect(
      inferSetKeyFromTitle("A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES"),
    ).toBe("Topps Chrome Sapphire");
  });

  it("does not disturb the soccer Prizm competition refinement", () => {
    expect(inferSetKeyFromTitle("2025 Panini Prizm World Cup Qatar #1")).toBe(
      "panini-prizm-fifa-world-cup-qatar",
    );
  });

  it("does not disturb the Hoops Premium Stock vs bare Prizm ordering (#1715 class)", () => {
    expect(inferSetKeyFromTitle("2024 NBA Hoops Premium Stock Red Ice Prizm #45")).toBe(
      "Panini NBA Hoops Premium Stock",
    );
  });
});

describe("the 2026-09-03 DISTINCT pairs are normalizeSetKey fixed points", () => {
  // Every pair Drew ruled 2026-09-03 ("Set collapse is forbidden, all pairs
  // distinct"), read from project_census_rulings_2026_09_03.md ruling 1.
  // Each entry is [theDistinctKey, theFlagshipItMustNeverCollapseTo].
  const RULED_DISTINCT_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["bowmans-best", "bowman"],
    ["bowman-sterling", "bowman"],
    ["bowman-heritage", "bowman"],
    ["bowman-chrome", "bowman"],
    ["topps-chrome-platinum", "topps-chrome"],
    ["topps-chrome-update-series", "topps-chrome"],
    ["donruss-elite", "panini-donruss"],
    ["donruss-studio", "panini-donruss"],
    ["diamond-kings", "panini-donruss"],
    ["topps-allen-ginter", "topps"],
    ["topps-gold-label", "topps"],
    ["bowman-draft-sapphire", "bowman-chrome-sapphire"],
    ["fleer-tradition", "fleer"],
    ["metal-universe", "fleer"],
    ["skybox-premium", "skybox"],
    ["panini-prizm-wnba", "panini-prizm"],
    ["panini-prizm-draft-picks", "panini-prizm"],
    ["upper-deck-black-diamond", "upper-deck"],
    ["bowman-draft-picks-and-prospects", "bowman-draft"],
  ];

  it.each(RULED_DISTINCT_PAIRS)("%s is a fixed point, never %s", (distinctKey, flagship) => {
    expect(normalizeSetKey(distinctKey)).toBe(distinctKey);
    expect(normalizeSetKey(distinctKey)).not.toBe(flagship);
  });

  it("every ruled flagship on the other side of a pair is also a fixed point", () => {
    const flagships = new Set(RULED_DISTINCT_PAIRS.map(([, f]) => f));
    for (const flagship of flagships) {
      expect(normalizeSetKey(flagship)).toBe(flagship);
    }
  });
});
