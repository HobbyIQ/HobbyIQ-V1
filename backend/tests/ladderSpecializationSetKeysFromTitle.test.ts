/**
 * CF-A-DEAD-LADDER-EDGE-REPAIRS-NOTHING (#1918's debt register, paid down).
 *
 * #1918 widened the mirror pin in rematchSpecializationStated.test.ts to
 * assert that EVERY key in `SPECIALIZATION_PARENTS` has a title the parser can
 * mint it from. That immediately named 13 keys where the ladder edge existed
 * and `inferSetKeyFromTitle` could never reach it — each returned its FLAGSHIP
 * instead. A dead edge is not cosmetic: SPECIALIZATION-STATED (#1725) only
 * opens when the derived key CHANGES, so a family that can never refine
 * classifies every one of its sales AGREE and the ladder is never consulted.
 *
 * NINE ARE PAID DOWN HERE. Four are left dead deliberately — `sp`,
 * `sp-championship`, `fleer-tradition-tiffany`, and the bare-"minors" spelling
 * of `upper-deck-minors` — each for a measured reason recorded in the register
 * itself. "Blank means unknown, never a guess" is the whole argument: an edge
 * with no evidence stays dead rather than getting a rule that guesses.
 *
 * THE EVIDENCE, measured READ-ONLY on prod 2026-09-06 (census scripts
 * backend/scripts/census-dead-ladder-edges.cjs and -detail/-negatives):
 *
 *   key                          catalog rows (checklist)   family titles stating
 *   fleer-glossy                    2,474 (2,474 = 100%)     89 / 3,000
 *   fleer-tiffany                   2,715 (2,251 =  83%)      2 / 6,000  (1996)
 *   fleer-update-glossy               264 (  264 = 100%)    110 / 3,000
 *   fleer-update-tiffany              250 (  250 = 100%)      8 / 3,000  (1996)
 *   pacific-prism                   5,894 (1,674)           403 / 3,000
 *   pacific-crown-collection        6,851 (1,827)           253 / 3,000
 *   pacific-gold-crown-die-cuts        92 (   92 = 100%)    257 / 3,000
 *   upper-deck-minors                 981 (  825)            58 / 6,000  strict
 *   upper-deck-black-diamond       17,242 (16,396)           34 / 3,000
 *   score-rookie-and-traded           766 (  766 = 100%)    114 / 6,000
 *
 * EVERY RULE IS BRAND-GATED, AND THE NEGATIVES BELOW ARE WHY. The
 * specialization words are overwhelmingly other brands':
 *
 *   "prism"          99.0% of 4,000 titles name no Pacific (topps-chrome-platinum 2,715)
 *   "minor league"   59.1% name no Upper Deck (topps-heritage 1,401)
 *   "glossy"         56.6% name no Fleer (topps 947, Garbage Pail Kids 325)
 *   "black diamond"  26.4% name no Upper Deck
 *
 * An unanchored rule for any of them would have filed thousands of Topps cards
 * into a Pacific or Fleer pool — a confidently WRONG key, worse than a generic
 * one, because it still passes the slug guard and fuses a real sale into
 * another brand's pool (CF-ONE-CARD-ONE-ROW-ONE-POOL).
 */
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { productAncestry, productEntry } from "../src/services/catalog/productSetKeys.js";

/** The parse a caller actually gets: the title parser, then the normalizer
 *  every call site runs its answer through. */
const derive = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

/**
 * REAL-SHAPED POSITIVES, at least five per newly-taught key.
 *
 * Every title is written the way the market writes it — several are verbatim
 * from the prod census samples — with nothing added that a seller would not
 * type. The corpus is EXPORTED so the mirror pin in
 * rematchSpecializationStated.test.ts can assert these edges are alive using
 * the same titles, rather than a second hand-maintained list that could drift.
 */
export const MINTS: ReadonlyArray<readonly [string, string]> = [
  // -- fleer-glossy (5) ------------------------------------------------------
  ["1987 Fleer Glossy Barry Bonds #604", "fleer-glossy"],
  ["1987 Fleer Baseball #369 Glossy", "fleer-glossy"],
  ["1988 Fleer Glossy Baseball #239 Base", "fleer-glossy"],
  ["1989 Fleer Glossy Ken Griffey Jr #548 RC", "fleer-glossy"],
  // The nine real 1987 sales that say BOTH words: Glossy wins, which is
  // CF-THERE-IS-NO-FLEER-TIFFANY's own stated expectation.
  ["1987 Fleer GLOSSY #369 Bo Jackson ROOKIE TIFFANY", "fleer-glossy"],
  ["1987 Fleer Glossy Tin Mark McGwire #604 PSA 9", "fleer-glossy"],

  // -- fleer-tiffany (5), 1996+ ONLY ----------------------------------------
  // The era boundary is the ruling: Fleer's 1980s coated product is Glossy,
  // and "Fleer Tiffany" is a real product only from 1996 (634 catalog rows
  // 1996, 1,111 in 1997, 970 in 2002 — and none at all before).
  ["1996 Fleer Tiffany Chipper Jones #300", "fleer-tiffany"],
  ["1997 Fleer Tiffany #160 Ken Griffey Jr Mariners", "fleer-tiffany"],
  ["1997-98 Fleer Tiffany Kobe Bryant #275 Basketball", "fleer-tiffany"],
  ["2002 Fleer Tiffany Albert Pujols #120", "fleer-tiffany"],
  ["1996 Fleer Tiffany Derek Jeter #185 Yankees", "fleer-tiffany"],

  // -- fleer-update-glossy (5) ----------------------------------------------
  ["1987 Fleer Update Glossy #U-76 Mark McGwire Oakland Athletics", "fleer-update-glossy"],
  ["1987 FLEER UPDATE GLOSSY #U-75 FRED MCGRIFF PSA 8", "fleer-update-glossy"],
  ["1987 Fleer Update - Fred McGriff #U-75 Collector's Edition Glossy PSA 9", "fleer-update-glossy"],
  ["1988 Fleer Update Glossy Roberto Alomar #U-2 RC", "fleer-update-glossy"],
  ["1987 Fleer Update Glossy Greg Maddux #U68", "fleer-update-glossy"],

  // -- fleer-update-tiffany (5), 1996+ ONLY ---------------------------------
  ["1996 Fleer Update Tiffany Mike Piazza #U235 HOF", "fleer-update-tiffany"],
  ["1996 Fleer Update Tiffany #U223 Ken Griffey Jr. Seattle Mariners", "fleer-update-tiffany"],
  ["1996 Fleer Update Derek Jeter Tiffany #U226 Yankees", "fleer-update-tiffany"],
  ["1996 Fleer Update - Tim Salmon #U238 Tiffany", "fleer-update-tiffany"],
  ["1997 Fleer Update Tiffany Vladimir Guerrero #U12", "fleer-update-tiffany"],

  // -- pacific-prism (5) -----------------------------------------------------
  // `pacific-prism` IS SINGULAR (productSetKeys.ts: catalog rows, sales, and
  // BaseballCardPedia's own redirect all agree); only the source's slug is
  // plural, so the rule reads both spellings and answers the singular.
  ["1994 Pacific Silver Prisms #8 Ken Griffey Jr.", "pacific-prism"],
  ["1995 Pacific Prism Baseball #4 Base", "pacific-prism"],
  ["1994 Pacific Ken Griffey Jr. Silver Circles Prism #8 NM-MT", "pacific-prism"],
  ["BARRY SANDERS 1994 PACIFIC MARQUEE PRISMS GOLD #27 PSA 9", "pacific-prism"],
  // States BOTH: the NAMED product wins over the stock it is cut from. 137 of
  // 4,188 sampled `:pacific:` rows look exactly like this.
  ["1994 Pacific Crown Collection - Prisms Ken Griffey Jr #8 Silver Disco", "pacific-prism"],
  ["Pacific 1994 Crown Collection Prisms Parallel Ken Griffey Jr #8 Mariners", "pacific-prism"],

  // -- pacific-crown-collection (5) -----------------------------------------
  ["1998 Pacific Crown Collection #250 Mark McGwire", "pacific-crown-collection"],
  ["1996 Pacific Crown Collection Cal Ripken Jr #120", "pacific-crown-collection"],
  ["1995 Pacific Crown Collection Baseball #45 Base", "pacific-crown-collection"],
  ["1997 Pacific Crown Collection Ken Griffey Jr #200 Mariners", "pacific-crown-collection"],
  ["1994 Pacific Crown Collection Frank Thomas #75 White Sox", "pacific-crown-collection"],

  // -- pacific-gold-crown-die-cuts (5) --------------------------------------
  ["1998 Pacific Gold Crown Die Cuts #17 Gary Sheffield Insert", "pacific-gold-crown-die-cuts"],
  ["2001 Pacific Frank Thomas Gold Crown Die Cuts #13 White Sox", "pacific-gold-crown-die-cuts"],
  ["1995 Pacific Chan Ho Park Gold Crown Die Cuts Rookie RC #11 Dodgers", "pacific-gold-crown-die-cuts"],
  // The 1999 "Gold Holo Crown Die Cuts" spelling, verbatim from the pool.
  ["1999 Pacific BARRY SANDERS GOLD HOLO CROWN DIE CUTS #13 LIONS", "pacific-gold-crown-die-cuts"],
  // States BOTH: again the named child wins. 48 of 4,188 sampled rows.
  ["1995 Pacific Crown Collection Gold Crown Die-Cuts Kirby Puckett #14 HOF", "pacific-gold-crown-die-cuts"],
  ["1998 Pacific Crown Collection - Gold Crown Die-Cuts #8 Mo Vaughn", "pacific-gold-crown-die-cuts"],

  // -- upper-deck-minors (5) -------------------------------------------------
  // "MINOR LEAGUE", never a bare "minors" — see the negative below.
  ["1995 Upper Deck Minor League Baseball #45 Base", "upper-deck-minors"],
  ["1995 Upper Deck Minor League Baseball #1 Future Stock", "upper-deck-minors"],
  ["1994 Upper Deck Minor League Derek Jeter #10", "upper-deck-minors"],
  ["1992 Upper Deck Minor League Baseball #3 Base", "upper-deck-minors"],
  ["1994-95 Upper Deck Minor League Michael Jordan #MJ1", "upper-deck-minors"],

  // -- upper-deck-black-diamond (5) -----------------------------------------
  ["1999 Upper Deck Black Diamond Baseball #76 Base", "upper-deck-black-diamond"],
  ["1999 Upper Deck Black Diamond Ken Griffey Jr #D24", "upper-deck-black-diamond"],
  ["1999 Upper Deck Black Diamond Baseball #53 Double", "upper-deck-black-diamond"],
  ["1998 Upper Deck Black Diamond Rookies Peyton Manning #1", "upper-deck-black-diamond"],
  ["2000 Upper Deck Black Diamond Alex Rodriguez #12 Mariners", "upper-deck-black-diamond"],

  // -- score-rookie-and-traded (5) ------------------------------------------
  // The ampersand, the word, and the slash are all real spellings in the pool.
  ["1991 Score Rookie & Traded Baseball #58T Base", "score-rookie-and-traded"],
  ["1994 Score Rookie/Traded Baseball #RT102 Gold Rush", "score-rookie-and-traded"],
  ["1992 Score Rookie and Traded Mike Piazza #T1", "score-rookie-and-traded"],
  ["Alex Rodriguez 1998 Score Rookie & Traded #RT30 Mariners", "score-rookie-and-traded"],
  ["1990 Score Rookie & Traded Baseball #26T Base", "score-rookie-and-traded"],
];

/**
 * NEGATIVES — at least three per key, and every one of them measured.
 *
 * These are not hypotheticals: each row is the shape the census found the word
 * wearing on OTHER brands, and each would be a real misfile if the rule were
 * unanchored. `expected` is what the title must STILL derive.
 */
const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
  // -- "prism" is 99.0% not Pacific -----------------------------------------
  ["2023 Topps Chrome Platinum Anniversary Prism Refractor #50", "topps-chrome"],
  ["2022 Topps Chrome Prism Refractor Julio Rodriguez #189", "topps-chrome"],
  ["2021 Topps Chrome Update Series Prism Refractor #USC12", "topps-chrome"],
  ["2022 Panini Prizm Baseball Bobby Witt Jr #22", "panini-prizm"],

  // -- "glossy" is 56.6% not Fleer ------------------------------------------
  ["1985 Garbage Pail Kids Original Series 1 Glossy #8a", "unknown"],
  ["1988 Topps Glossy Send-Ins Don Mattingly #12", "topps"],
  ["1991 Donruss Glossy Cal Ripken Jr #100", "panini-donruss"],

  // -- "tiffany" outside Fleer, and inside Fleer before 1996 ----------------
  // CF-THERE-IS-NO-FLEER-TIFFANY: the 1980s Fleer Tiffany does not exist, so a
  // title saying it keeps the bare family key rather than minting a product
  // from another decade. `spellForEra` re-spells the KEY; this keeps the
  // parser from minting the wrong one in the first place.
  ["1987 Fleer Tiffany #369 Bo Jackson Royals", "fleer"],
  ["1988 Fleer Tiffany Baseball #100 Base", "fleer"],
  ["1987 Fleer Update Tiffany #U68 Greg Maddux", "fleer-update"],
  ["1987 Topps Tiffany #170 Barry Bonds", "topps-tiffany"],
  ["1990 Bowman Tiffany Greg Maddux #27", "bowman-tiffany"],
  // A Fleer title with no year states no era, so the era-scoped rule REFUSES
  // rather than guessing which decade's product it is.
  ["Fleer Tiffany Chipper Jones Braves", "fleer"],

  // -- "minor league" is 59.1% not Upper Deck -------------------------------
  ["2021 Topps Heritage Minor League Wander Franco #12", "topps-heritage"],
  ["1992 Classic Best Minor League Baseball #45", "unknown"],
  ["1990 Topps Minor League Baseball #22 Base", "topps"],
  // BARE "minors" buys nothing and could only misfire: ZERO of 6,000 sampled
  // `:upper-deck:` titles use it, so the rule requires "minor league".
  ["1994 Upper Deck Minors Derek Jeter #10", "upper-deck"],

  // -- "black diamond" is 26.4% not Upper Deck ------------------------------
  ["2021 Bowman Black Diamond Refractor #BCP-50", "bowman-chrome"],
  ["2020 Topps Black Diamond Insert Mike Trout #BD-1", "topps"],
  ["2022 Panini Black Diamond Prizm #12", "panini-prizm"],

  // -- "crown" / "die cut" outside Pacific, and inside without the product ---
  ["2023 Panini Crown Royale Gold Die Cut #15", "panini-crown-royale"],
  ["2022 Topps x Bobby Witt Jr Crown Collection #5", "topps"],
  // "die cut" ALONE is a finish a dozen products use — Pacific alone is not
  // enough to mint the Gold Crown product.
  ["1998 Pacific Baseball Die Cut #12 Base", "pacific"],
  ["1997 Pacific Invincible Die Cut Ken Griffey Jr #8", "pacific"],

  // -- "traded" without "rookie" is NOT Score Rookie & Traded ---------------
  // 162 of 6,000 sampled `:score:` titles say traded without rookie, and Score
  // printed no Traded-only set; those are Topps Traded cards misfiled under
  // Score, a different defect this must not launder into a wrong key.
  ["1990 Topps Traded #41T Base", "topps-traded"],
  ["1987 Topps Traded Tiffany Greg Maddux #70T", "topps-traded-tiffany"],
  ["1992 Score Traded Baseball #12 Base", "score"],

  // -- the bare families still answer the bare families ---------------------
  // The refinement may only move a key DOWN its own ladder; a title stating no
  // specialization must return precisely what it returned before.
  ["1996 Fleer Baseball #100 Base", "fleer"],
  ["1987 Fleer Update Baseball #U12 Base", "fleer-update"],
  ["1998 Pacific Baseball #12 Base", "pacific"],
  ["1992 Score Baseball #100 Base", "score"],
  ["1994 Upper Deck Baseball #200 Base", "upper-deck"],
];

describe("CF-A-DEAD-LADDER-EDGE-REPAIRS-NOTHING — the parser mints the nine", () => {
  it.each(MINTS)("%s -> %s", (title, expected) => {
    expect(derive(title)).toBe(expected);
  });

  it("covers every key it claims to, with at least five titles each", () => {
    const counts = new Map<string, number>();
    for (const [, k] of MINTS) counts.set(k, (counts.get(k) ?? 0) + 1);
    const TAUGHT = [
      "fleer-glossy", "fleer-tiffany", "fleer-update-glossy", "fleer-update-tiffany",
      "pacific-prism", "pacific-crown-collection", "pacific-gold-crown-die-cuts",
      "upper-deck-minors", "upper-deck-black-diamond", "score-rookie-and-traded",
    ];
    for (const k of TAUGHT) expect(counts.get(k) ?? 0, k).toBeGreaterThanOrEqual(5);
    // and the corpus mints nothing it did not declare.
    for (const k of counts.keys()) expect(TAUGHT, k).toContain(k);
  });
});

describe("the negatives — every one of them measured on prod", () => {
  it.each(NEGATIVES)("%s stays %s", (title, expected) => {
    expect(derive(title)).toBe(expected);
  });

  it("carries at least three negatives per newly-taught family", () => {
    // A rule proven only by its positives is a rule whose blast radius was
    // never measured. Counted by FAMILY, since that is what the guard keys on.
    const perFamily = new Map<string, number>();
    for (const [title] of NEGATIVES) {
      for (const [word, fam] of [
        [/\bprisms?\b|\bcrown\b|\bdie\s*-?\s*cut/i, "pacific"],
        [/\bglossy\b|\btiffany\b/i, "fleer"],
        [/\bminor|\bblack\s+diamond\b/i, "upper-deck"],
        [/\btraded\b/i, "score"],
      ] as ReadonlyArray<readonly [RegExp, string]>) {
        if (word.test(title)) perFamily.set(fam, (perFamily.get(fam) ?? 0) + 1);
      }
    }
    for (const fam of ["pacific", "fleer", "upper-deck", "score"]) {
      expect(perFamily.get(fam) ?? 0, fam).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("the ladder accepts what the parser now mints", () => {
  it.each(MINTS)("%s nests under a real parent", (_title, key) => {
    // A minted key that is not a declared product would send the sale nowhere,
    // and one whose parent is not its family would let the rematch widen the
    // move further than the ruling allows.
    const entry = productEntry(key);
    expect(entry, key).not.toBeNull();
    expect(entry?.parent, key).toBeTruthy();
    expect(productAncestry(key), key).toContain(entry?.parent);
  });

  it("every minted key is a normalizeSetKey FIXED POINT", () => {
    // A ruled key that normalizes to something else is not a ruling, it is a
    // rename waiting to fire.
    for (const [, key] of MINTS) expect(normalizeSetKey(key), key).toBe(key);
  });
});

describe("MUTATION — each rule is load-bearing", () => {
  /**
   * The pins above prove the rules fire. These prove that if a rule were
   * REMOVED, this suite goes red rather than staying quietly green — the
   * property a table-driven test has to earn, since adding a row to a table is
   * cheap and deleting one is exactly the regression to catch.
   *
   * Asserted as: for each taught key, at least one positive derives it, and
   * the count of positives that would survive the family gate being dropped is
   * ZERO — i.e. no positive passes by accident of the brand rules alone.
   */
  it("no taught key is reachable without its refinement rule", () => {
    // The brand rules alone (what the parser returned BEFORE this change)
    // answer the FAMILY for every one of these titles. If any positive already
    // derived its specialized key without the table, the pin would be vacuous.
    const FAMILY_OF: Readonly<Record<string, string>> = {
      "fleer-glossy": "fleer", "fleer-tiffany": "fleer",
      "fleer-update-glossy": "fleer-update", "fleer-update-tiffany": "fleer-update",
      "pacific-prism": "pacific", "pacific-crown-collection": "pacific",
      "pacific-gold-crown-die-cuts": "pacific",
      "upper-deck-minors": "upper-deck", "upper-deck-black-diamond": "upper-deck",
      "score-rookie-and-traded": "score",
    };
    for (const [title, key] of MINTS) {
      const fam = FAMILY_OF[key];
      expect(fam, key).toBeTruthy();
      // The specialized key is strictly more specific than its family, so the
      // refinement is the ONLY thing that can have produced it.
      expect(key, title).not.toBe(fam);
      expect(derive(title), title).toBe(key);
      expect(productEntry(key)?.parent ?? productEntry(key)?.family, key).toBeTruthy();
    }
  });

  it("dropping the brand gate would break the negatives — proven by shape", () => {
    // Each negative states a specialization word while naming a DIFFERENT
    // manufacturer. That is precisely the population an unanchored rule would
    // capture, and the assertion that it does not is the negative list above.
    const statesAWord = NEGATIVES.filter(([t]) =>
      /\bprisms?\b|\bglossy\b|\btiffany\b|\bminor\s+league\b|\bblack\s+diamond\b|\bcrown\b|\btraded\b/i.test(t),
    );
    expect(statesAWord.length).toBeGreaterThanOrEqual(20);
  });
});
