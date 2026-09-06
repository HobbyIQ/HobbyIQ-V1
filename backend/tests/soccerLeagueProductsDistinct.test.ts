// CF-A-LEAGUE-RELEASE-IS-NOT-ITS-FLAGSHIP (2026-09-06).
//
// Backfill run 34018058461 ingested the 2020 Topps Chrome UEFA Champions
// League checklist and reported:
//
//   SHORT INGEST — compared 2,747 staged identities against
//   2020/topps-chrome-uefa-champions-league: 1,944 present, 803 missing;
//   missing e.g. 1|base|0|, 1|refractor|0|, 1|purple refractor|0|250
//
// The 803 were not refused by a gate and not dropped by a pipe. The staged CSV
// holds 2,747 rows over 2,747 distinct identities and 2,747 distinct slugs,
// every row carrying a card number and a player. They were WRITTEN — onto
// addresses two OTHER 2020 soccer products already owned, because
// normalizeSetKey folded all three to bare `topps-chrome`:
//
//   hiq:soccer:2020:topps-chrome:1:base:no-auto
//     was held by topps-chrome-match-attax-bundesliga (André Hahn)
//   hiq:soccer:2020:topps-chrome:1:purple-refractor:no-auto:num-250
//     was held by topps-chrome-bundesliga (Marco Richter)
//
// while the checklist says card 1 is Lionel Messi. 600 landed on
// match-attax-bundesliga and 203 on bundesliga: 803, fully attributed.
//
// The ruling makes the 66 checklist-backed soccer league/competition keys
// fixed points, the mechanism setKeyReconciliation already provides. This
// pins the OUTPUT — the slug two products no longer share — rather than the
// table, so a regression shows up as the collision it actually is.

import { describe, it, expect } from "vitest";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { reconciledFixedPoints } from "../src/services/catalog/setKeyReconciliation.js";

/** The three 2020 soccer products whose card 1s collided in the live run. */
const COLLIDED_2020 = [
  "topps-chrome-uefa-champions-league",
  "topps-chrome-bundesliga",
  "topps-chrome-match-attax-bundesliga",
] as const;

const slugFor = (setKey: string, parallel: string, printRun: number | null) =>
  computeHobbyIqCardId({
    sport: "soccer", year: 2020, setKey, cardNumber: "1",
    parallel, isAuto: false, printRun,
    authoritativeSetKey: true,
  });

describe("CF-A-LEAGUE-RELEASE-IS-NOT-ITS-FLAGSHIP", () => {
  it("gives each of the three colliding 2020 products its own card-1 address", () => {
    // THE DEFECT, stated as the thing it broke: one address for three cards.
    const slugs = COLLIDED_2020.map((k) => slugFor(k, "Base", null));
    expect(new Set(slugs).size).toBe(3);
    // And each names its own product, not the family.
    for (const [i, k] of COLLIDED_2020.entries()) {
      expect(slugs[i]).toBe(`hiq:soccer:2020:${k}:1:base:no-auto`);
    }
  });

  it("separates the five identities the run named as missing", () => {
    // Verbatim from the run's `missing e.g.` line: 1|base|0|, 1|refractor|0|,
    // 1|purple refractor|0|250, 1|blue refractor|0|150, 1|gold refractor|0|50.
    const rungs: Array<[string, number | null]> = [
      ["Base", null], ["Refractor", null],
      ["Purple Refractor", 250], ["Blue Refractor", 150], ["Gold Refractor", 50],
    ];
    for (const [parallel, printRun] of rungs) {
      const uefa = slugFor("topps-chrome-uefa-champions-league", parallel, printRun);
      const bundesliga = slugFor("topps-chrome-bundesliga", parallel, printRun);
      const matchAttax = slugFor("topps-chrome-match-attax-bundesliga", parallel, printRun);
      expect(uefa).not.toBe(bundesliga);
      expect(uefa).not.toBe(matchAttax);
      expect(bundesliga).not.toBe(matchAttax);
      expect(uefa).toContain(":topps-chrome-uefa-champions-league:");
    }
  });

  it("keeps every ruled soccer key a fixed point of normalizeSetKey", () => {
    // A ruled key MUST be a normalizeSetKey fixed point, or the pool can never
    // name the checklist it already has. Counted, not spot-checked: a rule
    // that silently covers 3 of 66 would pass a sampled assertion.
    const ruled = [
      // -> topps
      "topps-uefa-club-competitions", "topps-mls", "topps-merlin-chrome-uefa-champions-league",
      "topps-tier-one-bundesliga", "topps-uefa-superstars", "topps-merlin-collection-chrome",
      "topps-bundesliga", "topps-uefa-champions-league", "topps-uefa-champions-league-japan-edition",
      "topps-uefa-japan-edition", "topps-uefa-champions-league-jade-edition",
      "topps-jade-edition-uefa-club-competitions", "topps-match-attax-uefa",
      "topps-uefa-1st-edition-club-competitions", "topps-carnaval-uefa-club-competitions",
      "topps-uefa-1st-edition", "topps-bundesliga-japan-edition", "topps-liverpool-fc-team-set",
      "topps-atletico-madrid-team-set", "topps-renaissance-mls", "topps-juventus-team-set",
      "topps-deco-uefa",
      // -> donruss-elite
      "donruss-elite-premier-league", "donruss-elite-serie-a", "donruss-elite-la-liga",
      "donruss-elite-fifa", "donruss-elite-laliga",
      // -> topps-chrome
      "topps-chrome-uefa-champions-league", "topps-chrome-bundesliga", "topps-chrome-spfl",
      "topps-chrome-match-attax-bundesliga", "topps-chrome-uefa-womens-champions-league",
      "topps-chrome-steve-aoki", "topps-chrome-atletico-de-madrid-team-set",
      "topps-chrome-paris-saint-germain", "topps-chrome-borussia-dortmund-team-set",
      "topps-chrome-bvb-borussia-dortmund", "topps-chrome-x-real-sociedad",
      // -> topps-finest
      "topps-finest-bundesliga", "topps-finest-uefa-champions-league",
      "topps-finest-uefa-club-competitions",
      // -> panini-prizm / score / panini-mosaic
      "panini-prizm-fifa-world-cup-qatar",
      "score-premier-league", "score-serie-a", "score-ligue-1", "score-fifa", "score-la-liga",
      "panini-mosaic-uefa-euro-2020", "panini-mosaic-serie-a", "panini-mosaic-laliga",
      "panini-mosaic-premier-league", "panini-mosaic-la-liga",
      "panini-mosaic-fifa-road-to-world-cup",
      // -> topps-stadium-club / leaf / panini-revolution
      "topps-stadium-club-chrome-uefa", "topps-stadium-club-chrome-bundesliga",
      "leaf-ultimate", "panini-revolution-premier-league",
      // -> topps-museum-collection / panini-select / topps-chrome-sapphire
      "topps-museum-collection-uefa-champions-league", "topps-museum-collection-uefa",
      "topps-museum-collection-bundesliga", "panini-select-uefa-euro-preview",
      "topps-chrome-sapphire-edition-uefa", "topps-chrome-sapphire-bundesliga",
      "topps-chrome-sapphire-edition-uefa-womens",
      // -> panini-national-treasures / bowman
      "panini-national-treasures-fifa-road-to-world-cup", "bowman-mls",
    ];
    expect(ruled.length).toBe(66);
    const collapsing = ruled.filter((k) => normalizeSetKey(k) !== k);
    expect(collapsing).toEqual([]);
    const fixed = new Set(reconciledFixedPoints());
    expect(ruled.filter((k) => !fixed.has(k))).toEqual([]);
  });

  it("leaves the flagships and the already-ruled sibling exactly where they were", () => {
    // MUTATION CHECK. The ruling must not widen into the families themselves:
    // a bare flagship key stays its own fixed point and keeps its own pool.
    expect(normalizeSetKey("topps-chrome")).toBe("topps-chrome");
    expect(normalizeSetKey("topps-finest")).toBe("topps-finest");
    expect(normalizeSetKey("topps-stadium-club")).toBe("topps-stadium-club");
    expect(normalizeSetKey("panini-mosaic")).toBe("panini-mosaic");
    expect(normalizeSetKey("panini-prizm")).toBe("panini-prizm");
    // And the sibling the 2026-09-03 census already made a fixed point on
    // 29,769 checklist rows is untouched — the contrast that identified the
    // cause (it was in the census; the 66 were acquired after it ran).
    expect(normalizeSetKey("topps-chrome-uefa-club-competitions"))
      .toBe("topps-chrome-uefa-club-competitions");
  });

  it("does not fold a NON-soccer product into a ruled soccer key", () => {
    // MUTATION CHECK, the other direction. These are exact-token rulings, never
    // prefix or substring tests, so a longer name that merely CONTAINS a ruled
    // key must not be captured by it.
    expect(normalizeSetKey("2026 Topps Chrome Baseball")).toBe("topps-chrome");
    expect(normalizeSetKey("2025 Bowman Baseball")).toBe("bowman");
    expect(normalizeSetKey("2024 Score Football")).toBe("score");
    // `leaf-ultimate` is ruled distinct and carries BOTH 7,173 soccer (2022)
    // and 960 hockey (2019) checklist rows — a real product in two verticals,
    // so the ruling must hold for hockey too rather than being soccer-scoped.
    expect(normalizeSetKey("leaf-ultimate")).toBe("leaf-ultimate");
    expect(normalizeSetKey("Leaf")).toBe("leaf");
  });
});
