// CF-A-NAME-SHAPE-IS-NOT-A-DIFFERENT-PLAYER (run 35638061024, 2026-09-21).
//
// Run 35638061024 (baseball 2025, topps-series-1/topps-series-2 -> topps)
// refused 127 catalog different-player pairs. A diagnosis against that run's
// own log (`gh run view 35638061024 --log`) classified ALL 127 as name-SHAPE
// noise, none a genuinely different player:
//
//   ~55%  multi-player league-leader/insert cards: the incumbent reads
//         "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR" against
//         the bare "Shohei Ohtani".
//   ~30%  a subset tag on the same player: "Joey Ortiz RCup" vs "Joey Ortiz",
//         "Ceddanne Rafaela FS" vs "Ceddanne Rafaela",
//         'Carlos Correa "Say Cheese!"' vs "Carlos Correa".
//   ~15%  Jr./Sr. presence: "Vladimir Guerrero Jr." vs "Vladimir Guerrero",
//         "Nacho Alvarez Jr." vs "Nacho Alvarez".
//
// EVERY PAIR BELOW IS A REAL PAIR FROM THAT RUN'S LOG, not invented -- pulled
// verbatim from the "REFUSED ... (this row) vs ... (at topps)" lines. The two
// genuinely-different-player pairs and the two "first name in the wrong
// position" pairs are real too: they are what proves this fix does not widen
// past what the diagnosis found.
//
// Pinned at TWO layers, because the fix is wired in two places:
//   1. `namesAgree` itself (scripts/lib/name-agreement.cjs / nameAgreement.ts)
//   2. `arbitratePlayer`'s conflict gate (catalogRowOps.service.ts), through
//      `moveCatalogRow` end to end -- the same shape foldNeverChangesThePlayer
//      .test.ts already pins the OLD refusal in.

import { describe, expect, it } from "vitest";
import type { Container } from "@azure/cosmos";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";
import { namesAgree } from "../src/services/catalog/nameAgreement.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjs = require("../scripts/lib/name-agreement.cjs") as { namesAgree: (a: unknown, b: unknown) => boolean };

// ── layer 1: namesAgree, the 127 real pairs (deduplicated to their unique
//    name-shapes -- the run repeats the same product-level pair across many
//    card numbers/parallels, and the shape is what this function decides on) ──

/** [incoming, incumbent, expectAgree] -- every row read verbatim from the
 *  run's "REFUSED ... (this row) vs ... (at topps)" lines. */
const REAL_PAIRS: ReadonlyArray<[string, string, boolean]> = [
  // ~55% -- multi-player league-leader / insert cards, bare name vs FIRST-listed.
  ["Shohei Ohtani", "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR", true],
  ["Tarik Skubal", "Tarik Skubal / José Berríos / Seth Lugo LL AL W", true],
  ["Chris Sale", "Chris Sale / Zack Wheeler / Shota Imanaga LL NL ERA", true],
  ["José Ramírez", "José Ramírez / Steven Kwan", true],
  ["José Ramírez", "José Ramírez / Aaron Judge / Brent Rooker LL AL RBI", true],
  ["Willy Adames", "Willy Adames / Shohei Ohtani / Manny Machado LL NL RBI", true],
  ["Tarik Skubal", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA", true],
  ["Aaron Judge", 'Aaron Judge / Juan Soto / Alex Verdugo "Bronx Bombers II"', true],
  ["Aaron Judge", "Aaron Judge / Juan Soto / Anthony Santander LL AL HR", true],
  ["Aaron Judge", "Aaron Judge / A Boogie Wit Da Hoodie", true],
  ["Carlos Correa", "Carlos Correa / Royce Lewis", true],
  ["Jonathan India", "Jonathan India / Elly De La Cruz", true],
  ["Wyatt Langford", "Wyatt Langford / Evan Carter", true],
  ["Oneil Cruz", "Oneil Cruz / Andrew McCutchen", true],
  ["Elly De La Cruz", 'Elly De La Cruz / Jonathan India "It Takes Two"', true],
  ["Manny Machado", 'Manny Machado / Jackson Merrill "All Smiles"', true],
  ["Marcell Ozuna", "Marcell Ozuna / Adam Duvall \"Let's Dance!\"", true],
  ["Will Brennan", 'Will Brennan / Steven Kwan "Incoming!"', true],
  ["Taylor Walls", 'Taylor Walls / Richie Palacios "Hoop Dreams"', true],
  ["Shohei Ohtani", "Shohei Ohtani / Luis Arraez / Marcell Ozuna LL NL AVG", true],

  // ~30% -- subset tag on the same player.
  ["Pete Crow-Armstrong", "Pete Crow-Armstrong FS", true],
  ["Joey Ortiz", "Joey Ortiz RCup", true],
  ["Michael Busch", "Michael Busch RCup", true],
  ["Ceddanne Rafaela", "Ceddanne Rafaela FS", true],
  ["Jackson Merrill", "Jackson Merrill RCup", true],
  ["Colt Keith", "Colt Keith RCup", true],
  ["Evan Carter", "Evan Carter FS", true],
  ["Jordan Westburg", "Jordan Westburg FS", true],
  ["Jackson Holliday", "Jackson Holliday FS", true],
  ["Colton Cowser", "Colton Cowser RCup", true],
  ["Nolan Schanuel", "Nolan Schanuel FS", true],
  ["Yoshinobu Yamamoto", "Yoshinobu Yamamoto FS", true],
  ["Carlos Correa", 'Carlos Correa "Say Cheese!"', true],
  ["Masyn Winn", "Masyn Winn RCup", true],
  ["Tyler Soderstrom", "Tyler Soderstrom FS", true],
  ["Kyle Harrison", "Kyle Harrison FS", true],

  // ~15% -- Jr./Sr. presence.
  ["Nacho Alvarez Jr.", "Nacho Alvarez", true],
  ["Vladimir Guerrero Jr.", "Vladimir Guerrero", true],

  // Still a real refusal: the single name IS in the multi-name list, but not
  // FIRST -- rule (a) compares the first-listed name only, by design (the
  // brief's own words: "a multi-name incumbent whose FIRST name differs must
  // refuse"). Both are real rows from run 35638061024, card #5 and #234.
  ["Ronel Blanco", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA", false],
  ["Chris Sale", "Zack Wheeler / Chris Sale / Shota Imanaga LL NL W", false],
];

describe("namesAgree -- every real pair from run 35638061024's 127 refusals", () => {
  it.each(REAL_PAIRS)("\"%s\" vs \"%s\" -> agree=%s", (a, b, expected) => {
    expect(namesAgree(a, b)).toBe(expected);
  });
});

describe("namesAgree -- genuinely different players still refuse (not in the 127, sanity check)", () => {
  it.each([
    ["Aaron Judge", "Juan Soto"],
    ["Will Brennan", "Steven Kwan"],
  ])("\"%s\" vs \"%s\" -> still disagree", (a, b) => {
    expect(namesAgree(a, b)).toBe(false);
  });
});

// CF-JR-AND-SR-ARE-DIFFERENT-PEOPLE (coordinator block, PR #2403, 2026-09-21).
// The FIRST version of rule (c) stripped the generational suffix from BOTH
// sides independently before comparing, so "Vladimir Guerrero Jr." and
// "Vladimir Guerrero Sr." both reduced to "vladimirguerrero" and namesAgree
// wrongly returned true. Jr. and Sr. name the SAME family's two DIFFERENT
// people, both of whom are carded on their own: Guerrero, Griffey, Ripken,
// Bonds, Fielder, Alomar, Tatis, Witt. The fix extracts each side's suffix
// SEPARATELY and refuses whenever both sides carry one and the tokens
// differ -- presence-vs-absence (one side bare) still agrees exactly as
// before; suffix-vs-suffix must match to agree.
const SUFFIX_VS_SUFFIX_PAIRS: ReadonlyArray<[string, string, boolean]> = [
  // Real families, two different people apiece -- must REFUSE.
  ["Vladimir Guerrero Jr.", "Vladimir Guerrero Sr.", false],
  ["Ken Griffey Jr.", "Ken Griffey Sr.", false],
  ["Cal Ripken Jr.", "Cal Ripken Sr.", false],
  ["Barry Bonds Jr.", "Barry Bonds Sr.", false],
  ["Prince Fielder Jr.", "Prince Fielder Sr.", false],
  ["Sandy Alomar Jr.", "Sandy Alomar Sr.", false],
  ["Fernando Tatis Jr.", "Fernando Tatis Sr.", false],
  ["Bobby Witt Jr.", "Bobby Witt Sr.", false],
  // Different tokens, not just Jr./Sr. -- II vs III, Jr. vs II.
  ["Ken Griffey Jr.", "Ken Griffey II", false],
  // Presence-vs-absence is UNCHANGED: one side bare still agrees.
  ["Bobby Witt Jr.", "Bobby Witt", true],
  ["Cal Ripken", "Cal Ripken Sr.", true],
  // Same token on both sides (a comma-spelling difference only) still agrees.
  ["Cal Ripken Jr.", "Cal Ripken, Jr.", true],
];

describe("namesAgree -- generational suffix is presence-vs-absence ONLY, never suffix-vs-suffix", () => {
  it.each(SUFFIX_VS_SUFFIX_PAIRS)("\"%s\" vs \"%s\" -> agree=%s", (a, b, expected) => {
    expect(namesAgree(a, b)).toBe(expected);
  });
});

// ── mirror equality: the .cjs and the .ts must agree on every fixture,
//    both directions, per the pokemonFinishFromTitle.ts mirror pattern ──

describe("namesAgree -- the .ts mirror and scripts/lib/name-agreement.cjs agree on every fixture", () => {
  const ALL_PAIRS: ReadonlyArray<[string, string]> = [
    ...REAL_PAIRS.map(([a, b]): [string, string] => [a, b]),
    ...SUFFIX_VS_SUFFIX_PAIRS.map(([a, b]): [string, string] => [a, b]),
    ["Aaron Judge", "Juan Soto"],
    ["Will Brennan", "Steven Kwan"],
    ["", "Aaron Judge"],
    ["Aaron Judge", ""],
  ];
  it.each(ALL_PAIRS)("ts(%s, %s) === cjs(%s, %s)", (a, b) => {
    expect(namesAgree(a, b)).toBe(cjs.namesAgree(a, b));
  });
});

// ── mutation checks: rule (b) subset-tag strip, rule (c) Jr./Sr. equivalence ──
//
// Each states the behaviour the OLD compare (a bare toLowerCase +
// [^a-z0-9]-strip on the whole string, with no tag stripping at all) had, and
// asserts the current code does NOT have it. Delete the corresponding rule
// from name-agreement.cjs / nameAgreement.ts and one of these goes red.

describe("mutation check -- rule (b), the subset-tag strip", () => {
  it("DROP THE RCup/FS STRIP -> red: a bare toLowerCase+strip never folds \"Joey Ortiz RCup\" onto \"Joey Ortiz\"", () => {
    // The pre-fix expression the script itself used to gate `contended`
    // (still visible as the FIRST half of that gate in rekey-product-setkey.cjs).
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Joey Ortiz", "Joey Ortiz RCup")).toBe(false); // the old defect
    expect(namesAgree("Joey Ortiz", "Joey Ortiz RCup")).toBe(true);  // the fix
  });

  it("DROP THE QUOTED-SUBSET-NAME STRIP -> red: a quoted insert name would still disagree", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Carlos Correa", 'Carlos Correa "Say Cheese!"')).toBe(false);
    expect(namesAgree("Carlos Correa", 'Carlos Correa "Say Cheese!"')).toBe(true);
  });

  it("the subset-tag vocabulary is CLOSED -- an unlisted trailing word is never stripped", () => {
    // "Soto" is not on the list, so "Juan Soto" must not fold onto "Juan".
    expect(namesAgree("Juan", "Juan Soto")).toBe(false);
    // A quoted phrase not in QUOTED_SUBSET_NAMES is left alone.
    expect(namesAgree("Bobby Witt", 'Bobby Witt "Not A Real Tag"')).toBe(false);
  });

  it("the league-leader suffix is matched by SHAPE (LL + league + stat), not by string-chopping", () => {
    expect(namesAgree("Chris Sale", "Chris Sale LL NL ERA")).toBe(true);
    // A near-miss shape (missing the league token) must not be swallowed by a
    // looser "drop the last N words" rule.
    expect(namesAgree("Chris Sale", "Chris Sale LL ERA")).toBe(false);
  });
});

// ── CF-A-TRAILING-RC-IS-NOT-A-DIFFERENT-PLAYER (run 36346769892, 2026-09-27,
//    repoint-sales-by-list REPORT). USC143: `REFUSED (name-disagreement)
//    tca-ebay::336715972267: sale "Adael Amador Teal" vs destination "Adael
//    Amador RC"`. Two artefacts closed by this PR:
//      1. the destination's checklist playerName carries a BARE trailing "RC"
//         -- this file's OWN header already says "Jonah Tong RC" ==
//         "Jonah Tong" is the right answer, and the closed
//         TRAILING_SUBSET_MARKERS list only had RCup/FS until now.
//      2. the sale's player string carries a parallel colour word ("Teal")
//         its own extraction left in -- closed by the NEW caller-supplied
//         `opts.stripTrailingTokens`, exercised here directly against the
//         .cjs (repoint-sales-by-list.cjs is the only caller that builds this
//         list; see repointSalesByList.test.ts for the end-to-end wiring).
//
// Scoped to `cjs.namesAgree` ONLY, and deliberately NOT folded into
// REAL_PAIRS/SUFFIX_VS_SUFFIX_PAIRS/ALL_PAIRS above: the .ts mirror
// (nameAgreement.ts, catalogRowOps.service.ts's arbitratePlayer gate) is
// untouched by this PR on purpose -- a src/ change forces a redeploy this fix
// does not need, and the header there already flags the divergence risk this
// carve-out exists to avoid until a follow-up ports rule (A) and the (opt-in,
// still-unused-by-arbitratePlayer) option there too. ──
describe("namesAgree -- bare trailing RC marker (USC143, run 36346769892)", () => {
  it("the run's own pair, base names only: \"Adael Amador\" vs \"Adael Amador RC\" agree", () => {
    expect(cjs.namesAgree("Adael Amador", "Adael Amador RC")).toBe(true);
  });

  it("RC on EITHER side agrees (presence-vs-absence, same shape as RCup/FS)", () => {
    expect(cjs.namesAgree("Adael Amador RC", "Adael Amador")).toBe(true);
    expect(cjs.namesAgree("Adael Amador", "Adael Amador RC")).toBe(true);
  });

  it("RC on BOTH sides still agrees", () => {
    expect(cjs.namesAgree("Adael Amador RC", "Adael Amador RC")).toBe(true);
  });

  it("this file's own header example -- \"Jonah Tong RC\" == \"Jonah Tong\"", () => {
    expect(cjs.namesAgree("Jonah Tong RC", "Jonah Tong")).toBe(true);
  });

  it("RC vs a DIFFERENT surname still refuses -- RC never widens past the same player", () => {
    expect(cjs.namesAgree("Adael Amador RC", "Julio Rodriguez RC")).toBe(false);
    expect(cjs.namesAgree("Adael Amador RC", "Julio Rodriguez")).toBe(false);
  });

  it("RCup is untouched by the new bare-RC marker (RCup already matched its own rule)", () => {
    expect(cjs.namesAgree("Joey Ortiz", "Joey Ortiz RCup")).toBe(true);
  });

  it("DROP THE BARE-RC MARKER -> red: without it \"Adael Amador\" would still disagree with \"Adael Amador RC\"", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Adael Amador", "Adael Amador RC")).toBe(false); // the old defect (run 36346769892)
    expect(cjs.namesAgree("Adael Amador", "Adael Amador RC")).toBe(true); // the fix
  });

  it("the unattested shapes stay OUT -- \"(RC)\" and \"RC SP\"/\"RC SSP\" are not on the closed list", () => {
    // Measured on the committed checklist corpus (backend/data/checklists/**/*.csv,
    // playerName column): 8,072 rows carry a bare trailing " RC", ZERO carry
    // "(RC)" or "RC SP"/"RC SSP" -- so only the bare shape is in the list.
    expect(cjs.namesAgree("Adael Amador", "Adael Amador (RC)")).toBe(false);
    expect(cjs.namesAgree("Adael Amador", "Adael Amador RC SP")).toBe(false);
    expect(cjs.namesAgree("Adael Amador", "Adael Amador RC SSP")).toBe(false);
  });
});

// ── CF-AU-AUTOGRAPHS-ARE-FORMAT-WORDS-NOT-SURNAMES (PR #2485 round 2,
//    2026-09-28). Independent review of the 2024 Bowman Chrome CPA residue
//    ran the REAL gate (namesAgree + the lane's own stripVocabularyForDestination
//    output) against 268 live sale docs the residue PR intended to repoint --
//    0/268 passed. The single largest recoverable failure shape (95 of 267,
//    measured against the review's own sample) is a bare trailing "Au" or
//    "Autographs" the sale's own extraction appended after the player's name
//    ("Anthony Baptist Au", title "... Prospect Autographs Anthony Baptist
//    #CPA-AB (AU, RC)"). Same shape and same closed-list treatment as the
//    existing RC/RCup/FS markers just above -- an auto-format vendor tag, not
//    a real surname. Measured against the 88-player, 1,385-row
//    hiq:baseball:2024:bowman:cpa-* checklist corpus this residue targets:
//    ZERO playerName strings end in "Au" or "Autographs". Deliberately scoped
//    to `cjs.namesAgree` only (same carve-out as the RC block above): a src/
//    change forces a redeploy this fix does not need. Deliberately NOT adding
//    a leading-strip rule ("Autos Allan Castro") or any team/city
//    abbreviation ("Texas", "Nats", "Mt", "Ny") -- those are open-ended and
//    unsafe to hardcode into a shared, global marker list; the residue PR
//    holds those sales to needsRuling instead. ──
describe("namesAgree -- bare trailing Au/Autographs marker (PR #2485 round 2, 2024 Bowman Chrome CPA residue)", () => {
  it("the review's own pair: \"Anthony Baptist Au\" vs \"Anthony Baptist\" agrees", () => {
    expect(cjs.namesAgree("Anthony Baptist Au", "Anthony Baptist")).toBe(true);
  });

  it("\"Autographs\" on either side agrees (presence-vs-absence, same shape as RCup/FS/RC)", () => {
    expect(cjs.namesAgree("Anthony Huezo Autographs", "Anthony Huezo")).toBe(true);
    expect(cjs.namesAgree("Anthony Huezo", "Anthony Huezo Autographs")).toBe(true);
  });

  it("\"Au\" and \"Autographs\" on BOTH sides still agrees", () => {
    expect(cjs.namesAgree("Ryan Lasko Au", "Ryan Lasko Au")).toBe(true);
  });

  it("Au vs a DIFFERENT surname still refuses -- Au never widens past the same player", () => {
    expect(cjs.namesAgree("Anthony Baptist Au", "Julio Rodriguez Au")).toBe(false);
    expect(cjs.namesAgree("Anthony Baptist Au", "Julio Rodriguez")).toBe(false);
  });

  it("FLOOR 1 still applies: a two-token \"<First> Au\" never strips down to a bare single first name", () => {
    // "Sam Au" read as one bare surname-shaped token pair would strip to the
    // single token "Sam" -- FLOOR 1 (never strip below two tokens) refuses
    // this exactly as it already does for RC/RCup/FS.
    expect(cjs.namesAgree("Sam Au", "Sam")).toBe(false);
  });

  it("DROP THE AU/AUTOGRAPHS MARKER -> red: without it \"Anthony Baptist Au\" would still disagree with \"Anthony Baptist\"", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Anthony Baptist Au", "Anthony Baptist")).toBe(false); // the old defect
    expect(cjs.namesAgree("Anthony Baptist Au", "Anthony Baptist")).toBe(true); // the fix
  });

  it("leading noise (\"Autos Allan Castro\") is NOT stripped -- this marker is trailing-only, by design", () => {
    expect(cjs.namesAgree("Autos Allan Castro", "Allan Castro")).toBe(false);
  });

  it("a team/city abbreviation is NOT on this closed list -- \"Ryan Lasko Au Oakland\" still disagrees", () => {
    expect(cjs.namesAgree("Ryan Lasko Au Oakland", "Ryan Lasko")).toBe(false);
  });
});

// ── opts.stripTrailingTokens: the CALLER-SUPPLIED closed list ──────────────
describe("namesAgree -- opts.stripTrailingTokens (caller-supplied, product-scoped)", () => {
  it("the run's own pair, full shape: \"Adael Amador Teal\" vs \"Adael Amador RC\" agree when the caller supplies the product's parallel vocabulary", () => {
    expect(
      cjs.namesAgree("Adael Amador Teal", "Adael Amador RC", {
        stripTrailingTokens: ["Teal Refractor", "Teal", "Refractor"],
      }),
    ).toBe(true);
  });

  it("with NO opts, the same pair still disagrees -- the third argument is opt-in, never ambient", () => {
    expect(cjs.namesAgree("Adael Amador Teal", "Adael Amador RC")).toBe(false);
  });

  it("strips ONLY the listed phrases, and only at the trailing END of the string", () => {
    // "Teal Adael Amador" -- Teal is LEADING, not trailing, so it is NOT stripped.
    expect(
      cjs.namesAgree("Teal Adael Amador", "Adael Amador", { stripTrailingTokens: ["Teal"] }),
    ).toBe(false);
    // A phrase not on the caller's list is left alone.
    expect(
      cjs.namesAgree("Adael Amador Teal", "Adael Amador", { stripTrailingTokens: ["Aqua"] }),
    ).toBe(false);
  });

  it("refusals still name-disagree when the remaining names differ after stripping", () => {
    // "Adael Amador Teal" vs "Julio Rodriguez RC" -> REFUSED (brief's own control).
    expect(
      cjs.namesAgree("Adael Amador Teal", "Julio Rodriguez RC", {
        stripTrailingTokens: ["Teal Refractor", "Teal", "Refractor"],
      }),
    ).toBe(false);
  });

  it("Jr./Sr. (rule c) still wins AFTER stripTrailingTokens -- a real suffix disagreement is never laundered by the caller's list", () => {
    // Rule (c) extracts the generational suffix from the TRUE end of the
    // string, BEFORE rule (b)/stripTrailingTokens ever run (see namesAgree's
    // own rule order) -- so the suffix must be the trailing token for either
    // rule to see it, exactly as it already is for the FIXED markers
    // (RCup/FS/RC): "Vladimir Guerrero Jr. Teal" ends in "Teal", not "Jr.",
    // and the pre-existing "opts.stripTrailingTokens is applied AFTER rule
    // (b), BEFORE rule (d)" ordering documented on namesAgree means a
    // trailing opts word placed AFTER the suffix hides the suffix from rule
    // (c) entirely -- the same limitation the fixed markers already have,
    // not a new one this PR introduces. So this fixture puts the suffix
    // where a real card title would: at the true end.
    expect(
      cjs.namesAgree("Vladimir Guerrero Teal Jr.", "Vladimir Guerrero Teal Sr.", {
        stripTrailingTokens: ["Teal"],
      }),
    ).toBe(false);
    // Presence-vs-absence still agrees once the colour word is stripped too.
    expect(
      cjs.namesAgree("Vladimir Guerrero Teal Jr.", "Vladimir Guerrero Teal", {
        stripTrailingTokens: ["Teal"],
      }),
    ).toBe(true);
  });

  it("an empty/absent stripTrailingTokens list behaves exactly as no opts at all", () => {
    expect(cjs.namesAgree("Adael Amador Teal", "Adael Amador RC", { stripTrailingTokens: [] })).toBe(false);
  });
});

// ── THE SURNAME FLOOR (review round 1, PR #2463) ────────────────────────────
//
// https://github.com/HobbyIQ/HobbyIQ-V1/pull/2463#issuecomment-5859674530.
// The REAL GATE-6 vocabulary for 2025 topps-chrome-update-series emits bare
// colour parallel words -- Green, Gold, Black, Orange, Red, Blue -- and a
// SURNAME that is also one of those colours ("Nick Green") stripped down to
// a bare first name, which then "agreed" with any other bare "Nick" (or
// "Nick RC"): a false merge with zero relation to whether the two sides are
// really the same player. Three floors close it -- see name-agreement.cjs's
// own header, "THE SURNAME FLOOR" -- and this block pins exactly the
// reviewer's three repro cases plus the four cases the fix must NOT break.
const COLOUR_STRIP = ["Green", "Gold", "Black", "Orange", "Red", "Blue"];

describe("namesAgree -- the surname floor (review round 1, PR #2463)", () => {
  it("REVIEWER CASE 1: \"Nick Green\" vs \"Nick\" REFUSES -- Green is Nick's surname, not a stray colour", () => {
    expect(cjs.namesAgree("Nick Green", "Nick", { stripTrailingTokens: COLOUR_STRIP })).toBe(false);
  });

  it("REVIEWER CASE 2: \"Nick Green\" vs \"Nick RC\" REFUSES -- same hole, with rule (b)'s own RC marker on the other side", () => {
    expect(cjs.namesAgree("Nick Green", "Nick RC", { stripTrailingTokens: COLOUR_STRIP })).toBe(false);
  });

  it("REVIEWER CASE 3 (must still work): \"Adael Amador Teal\" vs \"Adael Amador RC\" still agrees", () => {
    expect(
      cjs.namesAgree("Adael Amador Teal", "Adael Amador RC", {
        stripTrailingTokens: ["Teal Refractor", "Teal", "Refractor", ...COLOUR_STRIP],
      }),
    ).toBe(true);
  });

  it("FLOOR 1 (never strip below two tokens): a two-token side never loses its trailing word to the caller's list", () => {
    // "Chris Green" is 2 tokens; stripping "Green" would leave the bare
    // "Chris" (1 token) -- FLOOR 1 refuses the strip outright, whatever the
    // other side reads.
    expect(cjs.namesAgree("Chris Green", "Chris", { stripTrailingTokens: COLOUR_STRIP })).toBe(false);
    expect(cjs.namesAgree("Chris Green", "Chris RC", { stripTrailingTokens: COLOUR_STRIP })).toBe(false);
  });

  it("FLOOR 2 (a colour that is the OTHER side's surname is a surname): \"Chris Green\" vs \"Chris Green Refractor\" still agrees, keeping Green", () => {
    // Green is NOT stripped from either side (floor 1 blocks the 2-token
    // side outright; floor 2 backs it up), but "Refractor" strips cleanly
    // off the 3-token side via rule (b)'s own extension -- both reduce to
    // "Chris Green" and agree.
    expect(
      cjs.namesAgree("Chris Green", "Chris Green Refractor", { stripTrailingTokens: [...COLOUR_STRIP, "Refractor"] }),
    ).toBe(true);
  });

  it("a genuinely different player is never swept in by the colour vocabulary: \"Chris Green\" vs \"Chris Taylor\" refuses", () => {
    expect(
      cjs.namesAgree("Chris Green", "Chris Taylor", { stripTrailingTokens: [...COLOUR_STRIP, "Refractor"] }),
    ).toBe(false);
  });

  it("a multi-word colour phrase strips as ONE unit, not word-by-word", () => {
    // "Sky Blue Refractor" is listed as a whole phrase (the same shape
    // repoint-sales-by-list.cjs's own vocabulary builder emits for a listed
    // checklist name) -- it strips in one match, leaving a genuine 2-token
    // base behind, never landing on the single bare colour word "Blue".
    expect(
      cjs.namesAgree("Chris Amador Sky Blue Refractor", "Chris Amador", {
        stripTrailingTokens: ["Sky Blue Refractor", "Sky Blue", "Refractor", ...COLOUR_STRIP],
      }),
    ).toBe(true);
  });

  it("FLOOR 3 (a STRIP-produced single token never agrees) draws the line at NATIVE single tokens, which are unchanged", () => {
    // Floors 1-2 already refuse any strip that would leave fewer than two
    // tokens (see stripMarkers), so a side can only read as ONE token here
    // if it was already one bare word BEFORE any stripping ran -- never a
    // name this file manufactured by removing something. A native single
    // token (a mononym, a placeholder, a sparse field -- siblingRungTwinGuard
    // .test.ts's own fixtures compare bare "Alpha" this way) is treated
    // exactly like any other pair: fold and compare. This is what keeps a
    // pre-existing single-word-name fixture (identical single words agree)
    // working unchanged while still refusing a genuinely different pair.
    expect(cjs.namesAgree("Ohtani", "Ohtani")).toBe(true);
    expect(cjs.namesAgree("Ohtani", "Judge")).toBe(false);
  });

  it("FLOOR 1/2 do not touch the FIXED marker vocabulary's own pre-existing behaviour", () => {
    // Every rule-(b) fixed-marker fixture already leaves >= 2 tokens after
    // its own strip (RCup/FS/RC, quoted subset names, league-leader), so the
    // new floors change nothing about them.
    expect(cjs.namesAgree("Joey Ortiz", "Joey Ortiz RCup")).toBe(true);
    expect(cjs.namesAgree("Jonah Tong", "Jonah Tong RC")).toBe(true);
  });
});

describe("mutation check -- rule (c), Jr./Sr./II/III equivalence", () => {
  it("DROP THE GENERATIONAL-SUFFIX RULE -> red: \"Vladimir Guerrero Jr.\" would still disagree with \"Vladimir Guerrero\"", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Vladimir Guerrero Jr.", "Vladimir Guerrero")).toBe(false);
    expect(namesAgree("Vladimir Guerrero Jr.", "Vladimir Guerrero")).toBe(true);
  });

  it("II/III/IV/V presence is equivalent too, symmetric in either direction", () => {
    expect(namesAgree("Ken Griffey II", "Ken Griffey")).toBe(true);
    expect(namesAgree("Ken Griffey", "Ken Griffey II")).toBe(true);
  });

  it("DROP THE SUFFIX-EQUALITY CLAUSE -> red: Jr. would wrongly agree with Sr.", () => {
    // The FIRST (buggy) version of this rule stripped the suffix from BOTH
    // sides unconditionally, with no comparison of the two tokens -- exactly
    // this function, restated, so the assertion states the regression
    // precisely rather than describing it from a distance.
    const buggyStripBoth = (x: string, y: string) => {
      const strip = (s: string) => s.replace(/,?\s+(?:Jr|Sr|II|III|IV|V)\.?$/i, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      return strip(x) === strip(y);
    };
    expect(buggyStripBoth("Vladimir Guerrero Jr.", "Vladimir Guerrero Sr.")).toBe(true); // the regression
    expect(namesAgree("Vladimir Guerrero Jr.", "Vladimir Guerrero Sr.")).toBe(false);    // the fix
    expect(namesAgree("Ken Griffey Jr.", "Ken Griffey Sr.")).toBe(false);
    expect(namesAgree("Cal Ripken Jr.", "Cal Ripken Sr.")).toBe(false);
    // Presence-vs-absence must survive the fix unchanged.
    expect(namesAgree("Bobby Witt Jr.", "Bobby Witt")).toBe(true);
    expect(namesAgree("Cal Ripken", "Cal Ripken Sr.")).toBe(true);
  });
});

describe("mutation check -- rule (a) fires only on the FIRST-listed name, never a search of the whole list", () => {
  it("a multi-name incumbent whose FIRST name differs from the single-name side still refuses", () => {
    expect(namesAgree("Ronel Blanco", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA")).toBe(false);
  });
});

describe("mutation check -- genuinely different players are never swept into agreement", () => {
  it("two unrelated single names never agree, tag stripping or not", () => {
    expect(namesAgree("Aaron Judge", "Juan Soto")).toBe(false);
    expect(namesAgree("Will Brennan", "Steven Kwan")).toBe(false);
  });
});

// ── layer 2: end-to-end through moveCatalogRow, so the wiring into
//    arbitratePlayer's conflict gate is pinned, not just the standalone
//    function. Same fake-container shape foldNeverChangesThePlayer.test.ts
//    uses, so this suite is directly comparable to the OLD refusal it pins. ──

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}
const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

type Doc = Record<string, any>;

class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
  }
  has(id: string, pk?: string): boolean {
    return this.get(id, pk) !== undefined;
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set") throw new Error(`fake: unsupported patch op ${o.op}`);
          d[o.path.slice(1)] = o.value;
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!this.docs.has(k)) throw notFound();
        this.docs.delete(k);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`${this.name}.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
      fetchNext: async () => ({ resources: this.run(spec), continuationToken: undefined }),
      fetchAll: async () => ({ resources: this.run(spec) }),
    }),
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    throw new Error(`fake container: unsupported query ${spec.query}`);
  }
  writes(): string[] {
    return this.log.filter((l) => /\.(upsert|patch|delete) /.test(l));
  }
}

const FROM_KEY = "topps-series-1";
const TO_KEY = "topps";
const REASON = "ruled setKey re-key topps-series-1 -> topps";
const slug = (num: string, parallel: string, setKey: string) => `hiq:baseball:2025:${setKey}:${num}:${parallel}:no-auto`;

function toppsRow(setKey: string, num: string, parallel: string, player: string | null, over: Doc = {}): Doc {
  const id = slug(num, parallel, setKey);
  return {
    id, cardId: id, hobbyiqCardId: id,
    sport: "baseball", year: 2025, cardYear: 2025,
    setKey, setName: "2025 Topps",
    cardNumber: num, parallel: parallel === "base" ? "Base" : parallel, parallelSlug: parallel,
    isAuto: false, printRun: null,
    playerName: player, playerSlug: player ? player.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null,
    vendorIds: {},
    source: setKey === FROM_KEY ? "checklistinsider-2026-09-01" : "hobbymonitor-2026-09-10",
    confidence: 0.9,
    observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(fromRow: Doc, toRow: Doc | null, sales: Doc[] = []) {
  const log: string[] = [];
  const catalog = new FakeContainer("card_catalog", log, [fromRow, ...(toRow ? [toRow] : [])]);
  const pool = new FakeContainer("sold_comps", log, sales);
  return { log, catalog, pool, cat: catalog as unknown as Container, sales: pool as unknown as Container };
}

const move = (w: ReturnType<typeof world>, from: Doc, toSlug: string, opts: Doc = {}) =>
  moveCatalogRow(w.cat, from, toSlug, { setKey: TO_KEY }, {
    reason: REASON, repointNormalizedSetKey: true, salesContainer: w.sales, ...opts,
  });

describe("end to end -- namesAgree lets the real 35638061024 shapes reach the ordinary ladder", () => {
  it("#144 purple-rainbow-foil -- bare \"Shohei Ohtani\" vs the LL NL HR trio: no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "144", "purple-rainbow-foil", "Shohei Ohtani");
    const to = toppsRow(TO_KEY, "144", "purple-rainbow-foil", "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR", { vendorIds: { cardhedge: "ch-1" } });
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined(); // never even reached the arms
  });

  it("#165 gold-holo-foil -- \"Joey Ortiz\" vs \"Joey Ortiz RCup\": no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "165", "gold-holo-foil", "Joey Ortiz");
    const to = toppsRow(TO_KEY, "165", "gold-holo-foil", "Joey Ortiz RCup", { vendorIds: { cardhedge: "ch-2" } });
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#345 gold-diamante-foil -- \"Vladimir Guerrero Jr.\" vs \"Vladimir Guerrero\": no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "345", "gold-diamante-foil", "Vladimir Guerrero Jr.");
    const to = toppsRow(TO_KEY, "345", "gold-diamante-foil", "Vladimir Guerrero");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#81 gold-rainbow-foil -- \"Carlos Correa\" vs 'Carlos Correa \"Say Cheese!\"': no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "81", "gold-rainbow-foil", "Carlos Correa");
    const to = toppsRow(TO_KEY, "81", "gold-rainbow-foil", 'Carlos Correa "Say Cheese!"');
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#5 foilfractor -- \"Ronel Blanco\" (2nd-listed, not first) vs the trio: STILL REFUSED", async () => {
    const from = toppsRow(FROM_KEY, "5", "foilfractor", "Ronel Blanco");
    const to = toppsRow(TO_KEY, "5", "foilfractor", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(r.refusal?.reason).toBe("different-player-uncorroborated");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("#234 foilfractor -- \"Chris Sale\" (2nd-listed) vs the trio: STILL REFUSED", async () => {
    const from = toppsRow(FROM_KEY, "234", "foilfractor", "Chris Sale");
    const to = toppsRow(TO_KEY, "234", "foilfractor", "Zack Wheeler / Chris Sale / Shota Imanaga LL NL W");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("Jr. vs Sr. -- two DIFFERENT, both-carded people -- still REFUSED end to end", async () => {
    const from = toppsRow(FROM_KEY, "70", "base", "Vladimir Guerrero Jr.");
    const to = toppsRow(TO_KEY, "70", "base", "Vladimir Guerrero Sr.");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(r.refusal?.incomingPlayer).toBe("Vladimir Guerrero Jr.");
    expect(r.refusal?.incumbentPlayer).toBe("Vladimir Guerrero Sr.");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("Jr. presence-vs-absence still folds through end to end (unchanged by the Jr./Sr. fix)", async () => {
    const from = toppsRow(FROM_KEY, "71", "base", "Bobby Witt Jr.", { vendorIds: { cardhedge: "ch-9" } });
    const to = toppsRow(TO_KEY, "71", "base", "Bobby Witt");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("a genuinely different player still refuses when neither side is corroborated", async () => {
    const from = toppsRow(FROM_KEY, "99", "base", "Aaron Judge");
    const to = toppsRow(TO_KEY, "99", "base", "Juan Soto");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(r.refusal?.incomingPlayer).toBe("Aaron Judge");
    expect(r.refusal?.incumbentPlayer).toBe("Juan Soto");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("a genuinely different player (Will Brennan vs Steven Kwan) still refuses", async () => {
    const from = toppsRow(FROM_KEY, "26", "base", "Will Brennan");
    const to = toppsRow(TO_KEY, "26", "base", "Steven Kwan");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
  });

  it("corroboration still decides when namesAgree does NOT recognise the pair (Optic's own shape, unaffected)", async () => {
    // Sanity: the new gate must not swallow the case the OLD suite already
    // pins as arbitrable-by-evidence -- a genuinely different-player pair
    // that a title tally settles.
    const from = toppsRow(FROM_KEY, "38", "base", "Joe Burrow");
    const to = toppsRow(TO_KEY, "38", "base", "Trey Benson");
    const w = world(from, to);
    const r = await move(w, from, to.id, {
      playerEvidence: { titlePlayerCounts: { "Joe Burrow": 10, "Trey Benson": 0 } },
    });
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration?.by).toBe("sale-titles");
  });
});
