/**
 * CF-A-LEAGUE-RELEASE-IS-NOT-ITS-FLAGSHIP (Drew, 2026-09-06, #1863).
 *
 * #1863 ruled 66 soccer league/competition products DISTINCT and made every
 * one a `normalizeSetKey` fixed point, but nothing was taught to MINT them:
 * `inferSetKeyFromTitle` stopped at the family word, so "2022 Panini Prizm
 * World Cup Qatar Lionel Messi" returned `panini-prizm` and the four words
 * naming the product were never read. A derived key equal to the stored key
 * classifies AGREE, so the rematch's SPECIALIZATION-STATED arm (#1725) never
 * opened on a single soccer row.
 *
 * These tests pin BOTH halves of the repair together, because either alone is
 * inert: the parser must mint the key, and the ladder must recognise it.
 */
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { productAncestry, productEntry, productFamilyOf } from "../src/services/catalog/productSetKeys.js";

/** The parse a caller actually gets: the title parser, then the normalizer
 *  every call site runs its answer through. */
const derive = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

/**
 * REAL-SHAPED TITLES, one per ruled destination — 66 titles over 15 families
 * and every competition the ruling names. Each is written the way the market
 * writes it: year, brand, competition, player, and often a card number or a
 * parallel, with nothing added that a seller would not type.
 */
export const MINTS: ReadonlyArray<readonly [string, string]> = [
  // -- topps (22) -----------------------------------------------------------
  ["2023 Topps UEFA Club Competitions Vinicius Jr #100", "topps-uefa-club-competitions"],
  ["2022 Topps MLS Carlos Vela #12", "topps-mls"],
  ["2020 Topps Merlin Chrome UEFA Champions League Messi", "topps-merlin-chrome-uefa-champions-league"],
  ["2022 Topps UEFA Superstars Kylian Mbappe #45", "topps-uefa-superstars"],
  ["2021 Topps Merlin Collection Chrome Harry Kane", "topps-merlin-collection-chrome"],
  ["2021 Topps Bundesliga Robert Lewandowski #10", "topps-bundesliga"],
  ["2022 Topps UEFA Champions League Mohamed Salah #5", "topps-uefa-champions-league"],
  ["2022 Topps UEFA Champions League Japan Edition Messi", "topps-uefa-champions-league-japan-edition"],
  ["2022 Topps UEFA Japan Edition Neymar Jr", "topps-uefa-japan-edition"],
  ["2022 Topps UEFA Champions League Jade Edition Haaland", "topps-uefa-champions-league-jade-edition"],
  ["2023 Topps Jade Edition UEFA Club Competitions Bellingham", "topps-jade-edition-uefa-club-competitions"],
  ["2021 Topps Match Attax UEFA Champions League Mbappe", "topps-match-attax-uefa"],
  ["2023 Topps UEFA 1st Edition Club Competitions Rodri", "topps-uefa-1st-edition-club-competitions"],
  ["2023 Topps Carnaval UEFA Club Competitions Vinicius", "topps-carnaval-uefa-club-competitions"],
  ["2022 Topps UEFA 1st Edition Erling Haaland #12", "topps-uefa-1st-edition"],
  ["2021 Topps Bundesliga Japan Edition Musiala", "topps-bundesliga-japan-edition"],
  ["2022 Topps Liverpool FC Team Set Mohamed Salah", "topps-liverpool-fc-team-set"],
  ["2021 Topps Atletico Madrid Team Set Joao Felix", "topps-atletico-madrid-team-set"],
  ["2023 Topps Renaissance MLS Lionel Messi Inter Miami", "topps-renaissance-mls"],
  ["2021 Topps Juventus Team Set Cristiano Ronaldo", "topps-juventus-team-set"],
  ["2023 Topps Deco UEFA Champions League Haaland", "topps-deco-uefa"],
  ["2021 Topps Tier One Bundesliga Erling Haaland Auto", "topps-tier-one-bundesliga"],
  // -- topps-chrome (11) ----------------------------------------------------
  ["2020 Topps Chrome UEFA Champions League Erling Haaland #1 Refractor", "topps-chrome-uefa-champions-league"],
  // Not one of the 66: already a fixed point (29,769 checklist rows) with the
  // same parser gap. Both the full name and the market's "UCC" abbreviation.
  ["2022-23 Topps Chrome UEFA Club Competitions Neymar Jr #100", "topps-chrome-uefa-club-competitions"],
  ["2023/24 Topps Chrome UCC Joshua Kimmich Bayern Munich Auto /299", "topps-chrome-uefa-club-competitions"],
  ["2021 Topps Chrome Bundesliga Jamal Musiala #50", "topps-chrome-bundesliga"],
  ["2022 Topps Chrome SPFL Celtic Kyogo Furuhashi", "topps-chrome-spfl"],
  ["2021 Topps Chrome Match Attax Bundesliga Haaland", "topps-chrome-match-attax-bundesliga"],
  ["2022 Topps Chrome UEFA Womens Champions League Alexia Putellas", "topps-chrome-uefa-womens-champions-league"],
  ["2022 Topps Chrome Steve Aoki Kylian Mbappe", "topps-chrome-steve-aoki"],
  ["2021 Topps Chrome Atletico de Madrid Team Set Joao Felix", "topps-chrome-atletico-de-madrid-team-set"],
  ["2022 Topps Chrome Paris Saint-Germain Lionel Messi", "topps-chrome-paris-saint-germain"],
  ["2021 Topps Chrome Borussia Dortmund Team Set Jude Bellingham", "topps-chrome-borussia-dortmund-team-set"],
  ["2021 Topps Chrome BVB Borussia Dortmund Erling Haaland", "topps-chrome-bvb-borussia-dortmund"],
  ["2022 Topps Chrome x Real Sociedad Take Kubo", "topps-chrome-x-real-sociedad"],
  // -- topps-chrome-sapphire (3) --------------------------------------------
  ["2020 Topps Chrome Sapphire Edition UEFA Haaland", "topps-chrome-sapphire-edition-uefa"],
  ["2021 Topps Chrome Sapphire Bundesliga Musiala", "topps-chrome-sapphire-bundesliga"],
  ["2022 Topps Chrome Sapphire Edition UEFA Womens Champions League Putellas", "topps-chrome-sapphire-edition-uefa-womens"],
  // -- topps-finest (3) -----------------------------------------------------
  ["2021 Topps Finest Bundesliga Erling Haaland Refractor", "topps-finest-bundesliga"],
  ["2022 Topps Finest UEFA Champions League Vinicius Jr", "topps-finest-uefa-champions-league"],
  ["2023 Topps Finest UEFA Club Competitions Bellingham", "topps-finest-uefa-club-competitions"],
  // -- topps-stadium-club (2) -----------------------------------------------
  ["2019 Topps Stadium Club Chrome UEFA Kylian Mbappe", "topps-stadium-club-chrome-uefa"],
  ["2020 Topps Stadium Club Chrome Bundesliga Haaland", "topps-stadium-club-chrome-bundesliga"],
  // -- topps-museum-collection (3) ------------------------------------------
  ["2021 Topps Museum Collection UEFA Champions League Neymar", "topps-museum-collection-uefa-champions-league"],
  ["2022 Topps Museum Collection UEFA Erling Haaland", "topps-museum-collection-uefa"],
  ["2021 Topps Museum Collection Bundesliga Musiala", "topps-museum-collection-bundesliga"],
  // -- panini-mosaic (6) ----------------------------------------------------
  ["2021 Panini Mosaic UEFA Euro 2020 Kylian Mbappe", "panini-mosaic-uefa-euro-2020"],
  ["2022 Panini Mosaic Serie A Rafael Leao #10", "panini-mosaic-serie-a"],
  ["2022 Panini Mosaic LaLiga Jude Bellingham", "panini-mosaic-laliga"],
  ["2021 Panini Mosaic Premier League Phil Foden", "panini-mosaic-premier-league"],
  ["2022 Panini Mosaic La Liga Vinicius Junior", "panini-mosaic-la-liga"],
  ["2021 Panini Mosaic FIFA Road to World Cup Mbappe", "panini-mosaic-fifa-road-to-world-cup"],
  // -- panini-prizm / select / revolution / national-treasures (4) ----------
  ["2022 Panini Prizm World Cup Qatar Lionel Messi #1 Argentina", "panini-prizm-fifa-world-cup-qatar"],
  ["2023 Panini Select UEFA Euro Preview Jude Bellingham", "panini-select-uefa-euro-preview"],
  ["2021 Panini Revolution Premier League Mason Mount", "panini-revolution-premier-league"],
  ["2022 Panini National Treasures FIFA Road to World Cup Mbappe", "panini-national-treasures-fifa-road-to-world-cup"],
  // -- donruss-elite (5) ----------------------------------------------------
  ["2021 Donruss Elite Premier League Bruno Fernandes", "donruss-elite-premier-league"],
  ["2022 Donruss Elite Serie A Rafael Leao", "donruss-elite-serie-a"],
  ["2022 Donruss Elite La Liga Vinicius Junior", "donruss-elite-la-liga"],
  ["2022 Donruss Elite LaLiga Jude Bellingham", "donruss-elite-laliga"],
  ["2022 Donruss Elite FIFA World Cup Lionel Messi", "donruss-elite-fifa"],
  // -- score (5) ------------------------------------------------------------
  ["2022 Score Premier League Mohamed Salah #7", "score-premier-league"],
  ["2022 Score Serie A Rafael Leao", "score-serie-a"],
  ["2022 Score Ligue 1 Kylian Mbappe", "score-ligue-1"],
  ["2022 Score La Liga Vinicius Junior", "score-la-liga"],
  ["2022 Score FIFA World Cup Lionel Messi", "score-fifa"],
  // -- bowman / leaf (2) ----------------------------------------------------
  ["2024 Bowman MLS Cavan Sullivan #1", "bowman-mls"],
  ["2022 Leaf Ultimate Soccer Erling Haaland Auto", "leaf-ultimate"],
];

describe("the title parser mints the ruled soccer league products", () => {
  it.each(MINTS)("%s -> %s", (title, expected) => {
    expect(derive(title)).toBe(expected);
  });

  it("covers at least 30 titles over 10 competitions and 4 families", () => {
    expect(MINTS.length).toBeGreaterThanOrEqual(30);
    const families = new Set(MINTS.map(([, key]) => productEntry(key)?.parent ?? ""));
    expect(families.size).toBeGreaterThanOrEqual(4);
    // The competitions the corpus actually exercises, counted from the titles.
    const competitions = [
      /champions league/i, /premier league/i, /bundesliga/i, /serie a/i,
      /la ?liga/i, /ligue 1/i, /\bmls\b/i, /world cup/i, /\beuro\b/i,
      /club competitions/i, /\bspfl\b/i, /match attax/i,
    ].filter((rx) => MINTS.some(([t]) => rx.test(t)));
    expect(competitions.length).toBeGreaterThanOrEqual(10);
  });

  it("covers all 66 ruled keys, plus the club-competitions sibling", () => {
    // The census's own list, so a key added to the ruling without a parser
    // rule fails here rather than silently staying unreachable. A destination
    // may appear twice only where a second SPELLING is being pinned (the
    // "UCC" abbreviation), never as an accidental duplicate row.
    const destinations = new Set(MINTS.map(([, k]) => k));
    expect(destinations.size).toBe(67);
    expect(destinations.has("topps-chrome-uefa-club-competitions")).toBe(true);
    // Exactly one destination is pinned twice, and it is that one.
    const counts = new Map<string, number>();
    for (const [, k] of MINTS) counts.set(k, (counts.get(k) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    expect(repeated).toEqual(["topps-chrome-uefa-club-competitions"]);
  });
});

describe("the ladder sees each minted key", () => {
  it.each(MINTS)("%s nests under its flagship", (_title, key) => {
    const entry = productEntry(key);
    expect(entry, key).not.toBeNull();
    const parent = entry?.parent ?? "";
    expect(parent, key).not.toBe("");
    expect(productAncestry(key), key).toContain(parent);
  });

  it("each is its OWN pricing family — a UEFA card does not price off an NFL comp", () => {
    for (const [, key] of MINTS) {
      expect(productFamilyOf(key), key).toBe(key);
    }
  });

  it("the derived key is a strict descendant, so SPECIALIZATION-STATED can open", () => {
    // L1 of the subclass, asked of the two halves together: the title mints
    // the child and the child's ancestry names the stored flagship. Before
    // this change the parser returned the flagship itself, `changed:setKey`
    // never fired, and the row classified AGREE.
    for (const [title, key] of MINTS) {
      const flagship = productEntry(key)?.parent ?? "";
      expect(derive(title), title).toBe(key);
      expect(productAncestry(key), key).toContain(flagship);
      expect(key, key).not.toBe(flagship);
    }
  });
});

describe("blank means unknown — the family key stands when no competition is stated", () => {
  const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
    // A soccer-capable BRAND with no competition in the title keeps the family.
    ["2022 Panini Prizm Soccer Erling Haaland #1", "panini-prizm"],
    ["2021 Topps Chrome Soccer Pedri Refractor", "topps-chrome"],
    ["2022 Topps Finest Soccer Jude Bellingham", "topps-finest"],
    ["2021 Panini Mosaic Soccer Phil Foden", "panini-mosaic"],
    // OTHER SPORTS: a "Prizm" title never gets a soccer key.
    ["2020 Panini Prizm Justin Herbert #325 Chargers RC", "panini-prizm"],
    ["2018 Panini Prizm Luka Doncic #280 Mavericks", "panini-prizm"],
    ["2021 Panini Select Football Trevor Lawrence", "panini-select"],
    ["2022 Topps Chrome Julio Rodriguez #220 Refractor", "topps-chrome"],
    ["1987 Topps Traded Greg Maddux #70T", "topps-traded"],
    ["2021 Panini Mosaic Basketball Cade Cunningham", "panini-mosaic"],
    ["2020 Topps Finest Luis Robert Refractor", "topps-finest"],
    ["1993 Score Baseball Derek Jeter #489", "score"],
    ["2021 Topps Museum Collection Baseball Shohei Ohtani", "topps-museum-collection"],
    ["2022 Topps Stadium Club Julio Rodriguez #100", "topps-stadium-club"],
    ["2020 Panini National Treasures Joe Burrow RPA", "panini-national-treasures"],
    ["2021 Panini Revolution Basketball LaMelo Ball", "panini-revolution"],
    ["2019 Topps Chrome Sapphire Edition Wander Franco", "topps-chrome-sapphire"],
    // "World Cup" inside a NON-soccer product is not a competition statement
    // for that family: Topps Chrome has no ruled World Cup release, so the
    // title keeps the family rather than being handed the nearest soccer key.
    ["2021 Topps Chrome Little League World Cup Special", "topps-chrome"],
  ];

  it.each(NEGATIVES)("%s stays %s", (title, expected) => {
    expect(derive(title)).toBe(expected);
  });

  it("'Qatar' alone, with no family words, mints nothing", () => {
    // The refinement reads a FAMILY the brand rules already decided. A title
    // naming no product cannot reach the table at all — absent beats wrong.
    expect(derive("2022 Qatar Airways Promo Card Lionel Messi")).toBe("unknown");
  });

  it("a competition word cannot invent a family the title never named", () => {
    // No brand, so no family, so no refinement: the competition alone is not
    // a product. This is the guard that keeps the table from minting on a
    // league name the way the old Sapphire rule minted on a finish.
    expect(derive("UEFA Champions League Final Matchday Programme 2022")).toBe("unknown");
    expect(derive("Premier League Season Review Sticker Album")).toBe("unknown");
  });
});
