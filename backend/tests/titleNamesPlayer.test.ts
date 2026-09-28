import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

const require_ = createRequire(__filename);
const { titleNamesPlayer, namesAgree, firstNonBlank } = require_(
  join(__dirname, "..", "scripts", "lib", "name-agreement.cjs"),
) as {
  titleNamesPlayer: (title: unknown, playerName: unknown, opts?: { stripTrailingTokens?: string[] }) => boolean;
  namesAgree: (a: unknown, b: unknown, opts?: { stripTrailingTokens?: string[] }) => boolean;
  firstNonBlank: (title: unknown, playerName: unknown) => string;
};

/**
 * titleNamesPlayer.test.ts -- unit coverage for lib/name-agreement.cjs's own
 * `titleNamesPlayer`, added by the CF-COLLISION-IS-NOT-A-DUPLICATE fix (PR
 * #2490 review: https://github.com/HobbyIQ/HobbyIQ-V1/pull/2490#issuecomment-5871669672).
 *
 * `namesAgree` alone compares two NAME-shaped strings and is the wrong tool
 * for a free-text sold_comps `title` (year, set, parallel, grade and all)
 * against a bare card_catalog `playerName` -- a strict whole-string fold
 * false-refuses almost every genuinely correct pair. `titleNamesPlayer`
 * layers a containment check on top, reusing `namesAgree`'s own primitives
 * (never reimplementing fold/strip logic), and this suite pins both
 * directions: real collisions still refuse, real matches still agree.
 */

describe("titleNamesPlayer: containment for free-text titles against a bare playerName", () => {
  it("agrees when the title is a full free-text listing naming the player plainly", () => {
    expect(titleNamesPlayer("2024 Bowman Chrome Victor Hurtado Gold Refractor Auto /50 #CPA-VH", "Victor Hurtado")).toBe(true);
    expect(titleNamesPlayer("Victor Hurtado Gold Refractor Auto", "Victor Hurtado")).toBe(true);
  });

  it("agrees case/diacritic-insensitively, same as namesAgree's own fold", () => {
    expect(titleNamesPlayer("2025 Bowman Ronald Acuna Jr Base #21 PSA 10", "Ronald Acuña Jr.")).toBe(true);
  });

  it("agrees even when the title omits a generational suffix the catalog row carries", () => {
    // The ordinary shape of a real listing title: sellers often drop "Jr.".
    // A title naming just "Vladimir Guerrero" still names Vladimir Guerrero
    // Jr.'s row -- presence-vs-absence, the same posture namesAgree's own
    // rule (c) already takes, extended here to the containment check.
    expect(titleNamesPlayer("2021 Bowman Vladimir Guerrero Base", "Vladimir Guerrero Jr.")).toBe(true);
  });

  it("REFUSES the real PR #2490 collision: a Cam Skattebo football title vs a Ronald Acuña Jr. baseball row", () => {
    expect(titleNamesPlayer(
      "2025 Panini Rookies & Stars Cam Skattebo Crusade Silver #21 Giants Rookie RC",
      "Ronald Acuña Jr.",
    )).toBe(false);
  });

  it("REFUSES the reviewed same-sport collision: a Connor Bedard title vs a Bryan Rust row", () => {
    expect(titleNamesPlayer("2025-26 O-Pee-Chee Connor Bedard #8 Blackhawks", "Bryan Rust")).toBe(false);
  });

  it("REFUSES other reviewed collisions from the same PR (Macklin Celebrini vs Jani Nyman, Mariano Rivera vs Ronald Acuña Jr.)", () => {
    expect(titleNamesPlayer("...#136 MACKLIN CELEBRINI OUTBURST RED /25 PSA 10", "Jani Nyman")).toBe(false);
    expect(titleNamesPlayer("...Certified Stars Mariano Rivera #21", "Ronald Acuña Jr.")).toBe(false);
  });

  it("never agrees on a blank title or a blank playerName", () => {
    expect(titleNamesPlayer("", "Victor Hurtado")).toBe(false);
    expect(titleNamesPlayer("Victor Hurtado Gold Refractor Auto", "")).toBe(false);
    expect(titleNamesPlayer(null, "Victor Hurtado")).toBe(false);
    expect(titleNamesPlayer("Victor Hurtado Gold Refractor Auto", undefined)).toBe(false);
  });

  it("Jr. vs Sr. protection carries through: a title naming the Sr. never agrees with a Jr. row via the no-suffix fallback", () => {
    // The no-suffix containment fallback tries "Ken Griffey" (Jr. stripped)
    // against the title -- but a title that names Ken Griffey SR plainly
    // ("Ken Griffey Sr.") still contains the substring "Ken Griffey", so this
    // pins that a title EXPLICITLY naming the Sr. does not get waved through
    // for a Jr. row just because the base name is a substring -- namesAgree's
    // own suffix-vs-suffix rule (c) still refuses when both sides carry an
    // explicit, DIFFERENT suffix; the containment fallback only ever helps
    // when the title carries NO suffix at all (true presence-vs-absence).
    // Here the title's own explicit "Sr." makes this a real disagreement,
    // and namesAgree's rule (c) is consulted first (this function tries
    // namesAgree before falling back to containment), so it refuses.
    expect(titleNamesPlayer("Ken Griffey Sr. Autograph Card", "Ken Griffey Jr.")).toBe(false);
  });

  it("the Jr./Sr. title-scan guard does not false-refuse on an unrelated Roman-numeral/set token in the title", () => {
    // Real bug found while building this fix: an early version scanned the
    // title for ANY of GENERATIONAL_SUFFIX's tokens (Jr/Sr/II/III/IV/V), and
    // "2025 Topps V Bobby Witt Jr Auto" (a set/parallel token "V", nothing to
    // do with generation) against playerName "Bobby Witt Jr." was read as the
    // title naming a "V" suffix that disagrees with "Jr" -- a false REFUSAL
    // of an obviously correct pair. The fix narrows the mid-title scan to
    // Jr/Sr only, exactly the pair this doctrine actually protects.
    expect(titleNamesPlayer("2025 Topps V Bobby Witt Jr Auto", "Bobby Witt Jr.")).toBe(true);
    expect(titleNamesPlayer("2025 Topps Series IV Victor Hurtado Auto", "Victor Hurtado")).toBe(true);
    expect(titleNamesPlayer("Victor Hurtado #V Refractor", "Victor Hurtado")).toBe(true);
  });

  it("the Jr./Sr. title-scan guard is skipped entirely when the player carries no suffix at all", () => {
    // No suffix on the player side means nothing to disagree about --
    // titleNamesPlayer must never scan the title for Jr/Sr tokens in this
    // case (there is no player suffix to compare them against).
    expect(titleNamesPlayer("2025 Topps Victor Hurtado Sr Night Auto", "Victor Hurtado")).toBe(true);
  });

  it("honours opts.stripTrailingTokens exactly like namesAgree does, for the USC143 shape", () => {
    // repoint-sales-by-list.cjs's own USC143 fixture, restated for the
    // title-vs-playerName direction: a sale title carrying a parallel colour
    // word ("Teal") the extraction left in, against a checklist row whose
    // playerName carries its own trailing marker ("RC").
    expect(titleNamesPlayer("Adael Amador Teal", "Adael Amador RC", { stripTrailingTokens: ["Teal"] })).toBe(true);
    // "RC" is already on rule (b)'s own FIXED closed vocabulary
    // (TRAILING_SUBSET_MARKERS), independent of any caller-supplied list, so
    // the marker-stripped fallback reduces "Adael Amador RC" to "Adael
    // Amador" even with no stripTrailingTokens at all -- and that base name
    // IS a substring of "Adael Amador Teal", so this pair agrees either way.
    // A caller-supplied list only matters for a WORD not already on that
    // fixed vocabulary (a product's own parallel colour, never a rookie/
    // subset marker this file already knows).
    expect(titleNamesPlayer("Adael Amador Teal", "Adael Amador RC")).toBe(true);
  });

  it("does NOT fold a word that is on neither the fixed vocabulary nor a caller-supplied list", () => {
    // "Chrome" is not a rule (b) marker and was not supplied by the caller --
    // stripMarkers leaves it exactly as printed, so the resulting base
    // ("Adael Amador Chrome") is NOT a substring of a title that never
    // mentions "Chrome" at all, and this pair correctly disagrees.
    expect(titleNamesPlayer("Adael Amador RayWave", "Adael Amador Chrome")).toBe(false);
  });

  it("falls through to namesAgree first -- a title that is itself just a bare name behaves identically to namesAgree alone", () => {
    expect(titleNamesPlayer("Derek Jeter", "Todd Hundley")).toBe(namesAgree("Derek Jeter", "Todd Hundley"));
    expect(titleNamesPlayer("Adael Amador", "Adael Amador")).toBe(namesAgree("Adael Amador", "Adael Amador"));
  });
});

// ── round 1 review (PR #2500 https://github.com/HobbyIQ/HobbyIQ-V1/pull/2500#issuecomment-5873357117),
// item 1 (BLOCKING): unbounded substring match had no word boundary ────────

describe("word-boundary containment -- a shorter name must never hide inside a longer one across a word boundary", () => {
  it("REFUSES Bryan Reynolds vs Ryan Reynolds -- the exact false-keeper shape the review reproduced", () => {
    // foldForCompare strips ALL whitespace before comparing, so a raw
    // substring check reads "...bryanreynoldsauto" as containing
    // "ryanreynolds" -- "Bryan" is never split into "B" + "ryan" by a real
    // reader, and this function must not either. This is the UNSAFE
    // direction: a false keeper promotion / false deletion-gate pass, the
    // exact failure mode this whole PR exists to close.
    expect(titleNamesPlayer("2025 Topps Chrome Bryan Reynolds Auto", "Ryan Reynolds")).toBe(false);
    expect(titleNamesPlayer("2025 Topps Chrome Bryan", "Ryan")).toBe(false);
  });

  it("REFUSES Jose Ramirez (title) vs Jose Ramirez Green (playerName) -- the title is missing a real token, not a coincidental substring hit", () => {
    // The catalog row's own trailing "Green" is a real surname token (THE
    // SURNAME FLOOR, #2463: a color word that is the OTHER side's own
    // surname is a surname, not a color, on this comparison) that the
    // title never spells at all -- token-subsequence containment correctly
    // finds no match, where a substring check over the FULL "Green"-less
    // player string would already have refused this shape too (this test
    // pins the boundary-safe path stays correct here, not a regression).
    expect(titleNamesPlayer("Jose Ramirez", "Jose Ramirez Green")).toBe(false);
  });

  it("REFUSES Nick (title) vs Nick Green (playerName) -- a bare first name never proves the fuller catalog name", () => {
    expect(titleNamesPlayer("Nick", "Nick Green")).toBe(false);
  });

  it("control: a title that genuinely contains the full token run still agrees", () => {
    expect(titleNamesPlayer("2025 Topps Nick Green Auto", "Nick Green")).toBe(true);
    expect(titleNamesPlayer("2025 Topps Chrome Ryan Reynolds Auto", "Ryan Reynolds")).toBe(true);
  });

  it("a hyphenated surname still matches as one token (fold applies within a token, never across a boundary)", () => {
    expect(titleNamesPlayer("2023 Bowman Pete Crow-Armstrong Chrome Auto", "Pete Crow-Armstrong")).toBe(true);
  });
});

// ── round 1 review, items 2/3: blank title must fall through to playerName ─

describe("firstNonBlank: a stored title of \"\" falls through to playerName, never short-circuits", () => {
  it("treats an empty string and a whitespace-only string as absent", () => {
    expect(firstNonBlank("", "Victor Hurtado")).toBe("Victor Hurtado");
    expect(firstNonBlank("   ", "Victor Hurtado")).toBe("Victor Hurtado");
    expect(firstNonBlank(null, "Victor Hurtado")).toBe("Victor Hurtado");
    expect(firstNonBlank(undefined, "Victor Hurtado")).toBe("Victor Hurtado");
  });

  it("prefers a non-blank title over playerName", () => {
    expect(firstNonBlank("2024 Bowman Chrome Victor Hurtado Auto", "Victor Hurtado")).toBe("2024 Bowman Chrome Victor Hurtado Auto");
  });

  it("returns an empty string when both are blank -- titleNamesPlayer then correctly refuses (nothing to check)", () => {
    expect(firstNonBlank("", "")).toBe("");
    expect(titleNamesPlayer(firstNonBlank("", ""), "Victor Hurtado")).toBe(false);
  });
});

// ── round 1 review, item 4: multi-name catalog row reduces to its first name

describe("multi-name playerName reduces to its first-listed name, same as namesAgree's own rule (a)", () => {
  it("agrees when the title names the FIRST-listed player of a league-leader-shaped catalog row", () => {
    expect(titleNamesPlayer(
      "2024 Topps Shohei Ohtani League Leaders NL HR",
      "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR",
    )).toBe(true);
  });

  it("still refuses when the title names a player NOT first-listed on the multi-name row", () => {
    // Being named second or third on the card is not being named first --
    // this function's multi-name reduction (like namesAgree's own rule (a))
    // does not search the rest of the list.
    expect(titleNamesPlayer(
      "2024 Topps Marcell Ozuna League Leaders NL HR",
      "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR",
    )).toBe(false);
  });

  it("still refuses a genuinely unrelated player against a multi-name row", () => {
    expect(titleNamesPlayer(
      "2025 Panini Rookies & Stars Cam Skattebo Crusade Silver #21 Giants Rookie RC",
      "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR",
    )).toBe(false);
  });
});
