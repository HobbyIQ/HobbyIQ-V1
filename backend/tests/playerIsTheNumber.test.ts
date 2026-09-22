// CF-PLAYER-IS-THE-NUMBER (Drew, 2026-08-18: "did they even have card
// numbers then?").
//
// They did not. `NNO` is accurate vendor data for sets that never carried
// numbers — 1909-11 T206 (6,025 rows), Magic Alpha/Beta/Arabian/The Dark
// (8,347), Leaf & Donruss Signature Series (3,487), 1964 Topps Stand-Up (954),
// 1966 Topps Rub-Offs (654). Only 6.4% of those rows have any `#number` in
// their title, and most of those are certs or print runs.
//
// Treating `nno` as an identity pooled 395 different players into one slug
// spanning $3.49-$103,700. Refusing it stopped the damage but left the cards
// unpriceable, because the missing number does not exist to be recovered.
//
// For an unnumbered card the PLAYER is the identifier, so it takes the
// cardNumber slot as `player-<player>`. The prefix is `player-` and not `p-`
// because promo cards genuinely carry P-1 / P-45 numbers, which slugify to
// p-1 / p-45 — the collision test below is what caught that.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  isUnnumberedCardNumber,
  unnumberedCardSegment,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

const t206 = (playerName: string) =>
  computeHobbyIqCardId({
    sport: "baseball", year: 1909, setKey: "1909-11 T206 Baseball",
    cardNumber: "NNO", parallel: "Base", isAuto: false, playerName,
  });

describe("CF-PLAYER-IS-THE-NUMBER", () => {
  it("gives each unnumbered card its own identity instead of one shared pool", () => {
    const wagner = t206("Honus Wagner");
    const cobb = t206("Ty Cobb");
    expect(wagner).toBe("hiq:baseball:1909:t206:player-honus-wagner:base:no-auto");
    expect(cobb).toBe("hiq:baseball:1909:t206:player-ty-cobb:base:no-auto");
    expect(wagner).not.toBe(cobb);
  });

  it("folds the name variants that would otherwise fragment a pool", () => {
    // All 20 fragmenting groups in the real data are case/punctuation only.
    expect(t206("Kiki Cuyler")).toBe(t206("KiKi Cuyler"));
    expect(t206("Kiki Cuyler")).toBe(t206('"Kiki" Cuyler'));
    expect(t206("Lebron James")).toBe(t206("LeBron James"));
    expect(t206("Pepper Martin")).toBe(t206('"Pepper" Martin'));
  });

  it("keeps DIGIT-bearing subjects distinct — they are different cards", () => {
    // These only looked like variants because a digit-stripping comparison
    // grouped them. Collapsing them would recreate the pooling being fixed.
    expect(t206("Checklist 1-154")).not.toBe(t206("Checklist 547-653"));
    expect(t206("1918 - Red Sox")).not.toBe(t206("1915 - Red Sox"));
  });

  it("cannot collide with a real card number — including promo P- numbers", () => {
    // The first prefix tried was `p-`, and this test rejected it: promo cards
    // really do carry P-1 / P-45, which slugify to p-1 / p-45. `player-` is a
    // segment no card number can produce.
    const numbered = computeHobbyIqCardId({
      sport: "baseball", year: 1909, setKey: "1909-11 T206 Baseball",
      cardNumber: "P-1", parallel: "Base", isAuto: false,
    });
    expect(numbered).toBe("hiq:baseball:1909:t206:p-1:base:no-auto");
    expect(numbered).not.toBe(t206("Honus Wagner"));
    expect(t206("Honus Wagner")).toContain(":player-");
  });

  // AMENDED by CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). The empty
  // string moved OUT of this list and into its own predicate. It was never a
  // spelling of "no number" — it is the absence of any spelling at all, and
  // reading it as an assertion is what let a parse failure reach for the
  // player pseudo-number. See unparsedIsNotUnnumbered.test.ts for the pin.
  it("recognises every spelling of 'no number'", () => {
    for (const n of ["NNO", "nno", " nno ", "no-number", "none", "unnumbered"]) {
      expect(isUnnumberedCardNumber(n), JSON.stringify(n)).toBe(true);
    }
    for (const n of ["30", "70T", "BDC-46", "US80", "0573"]) {
      expect(isUnnumberedCardNumber(n), JSON.stringify(n)).toBe(false);
    }
    // A blank is UNPARSED, not unnumbered — the amendment, stated here so the
    // two files cannot drift apart.
    expect(isUnnumberedCardNumber("")).toBe(false);
  });

  it("has no identity when there is neither a number nor a player", () => {
    expect(unnumberedCardSegment("")).toBeNull();
    expect(unnumberedCardSegment(null)).toBeNull();
    // 16 of the 50,989 real rows are in exactly this state.
    const g = guardSlugInputs({
      sport: "baseball", year: 1909, normalizedSetKey: "t206", cardNumber: "nno",
    });
    expect(g.ok).toBe(false);
    expect(g.reasons).toContain("cardnumber-missing");
  });

  it("the guard ACCEPTS an unnumbered card once a player identifies it", () => {
    const g = guardSlugInputs({
      sport: "baseball", year: 1909, normalizedSetKey: "t206",
      cardNumber: "nno", playerName: "Honus Wagner",
    });
    expect(g.ok).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  it("still refuses a real missing number when no player is supplied", () => {
    for (const n of ["", "null", "undefined"]) {
      const g = guardSlugInputs({
        sport: "baseball", year: 1964, normalizedSetKey: "topps", cardNumber: n,
      });
      expect(g.ok, JSON.stringify(n)).toBe(false);
    }
  });
});

// CF-T206-BACK-BRAND-IS-NOT-THE-PLAYER (owner-approved 2026-09-22).
//
// T206's vendor playerName field routinely carries the card's BACK BRAND
// (the tobacco/candy advertiser printed on the reverse) mixed into the
// player text. Measured live against sold_comps: "Sweet Caporal Ty Cobb",
// "Piedmont Ty Cobb" and "Ty Cobb Piedmont" all named the SAME card and
// minted three different player-<slug> addresses before this fix.
describe("CF-T206-BACK-BRAND-IS-NOT-THE-PLAYER", () => {
  it("strips a leading back-brand so the same player unifies to one address", () => {
    expect(unnumberedCardSegment("Sweet Caporal Ty Cobb", { year: 1909, setKey: "t206" }))
      .toBe(unnumberedCardSegment("Ty Cobb", { year: 1909, setKey: "t206" }));
    expect(unnumberedCardSegment("Piedmont Ty Cobb", { year: 1909, setKey: "t206" }))
      .toBe(unnumberedCardSegment("Ty Cobb", { year: 1909, setKey: "t206" }));
  });

  it("strips a trailing back-brand the same way", () => {
    expect(unnumberedCardSegment("Ty Cobb Piedmont", { year: 1909, setKey: "t206" }))
      .toBe("player-ty-cobb");
  });

  it("strips multi-word back brands (Old Mill, Polar Bear, El Principe de Gales)", () => {
    expect(unnumberedCardSegment("Old Mill Frank Chance", { year: 1909, setKey: "t206" }))
      .toBe("player-frank-chance");
    expect(unnumberedCardSegment("Polar Bear Michael Mike Donlin", { year: 1909, setKey: "t206" }))
      .toBe(unnumberedCardSegment("Michael Mike Donlin", { year: 1909, setKey: "t206" }));
  });

  it("strips factory/series tokens (Factory 25/30/42/649, N series)", () => {
    expect(unnumberedCardSegment("Sweet Caporal Factory 30 Rube Waddell", { year: 1909, setKey: "t206" }))
      .toBe("player-rube-waddell");
    expect(unnumberedCardSegment("Piedmont 350 Series Ty Cobb", { year: 1909, setKey: "t206" }))
      .toBe("player-ty-cobb");
  });

  it("real corrupted vendor strings (measured on prod tca-ebay t206 rows) unify onto one player address", () => {
    const variants = ["Sweet Caporal Ty Cobb", "Piedmont Ty Cobb", "Ty Cobb Piedmont"];
    const segments = variants.map((v) => unnumberedCardSegment(v, { year: 1909, setKey: "t206" }));
    expect(new Set(segments).size).toBe(1);
    expect(segments[0]).toBe("player-ty-cobb");
  });

  it("does NOT strip Ty Cobb's own name when no other back-brand noise is present", () => {
    // Regression guard: "ty"/"cobb" collide with the named "Ty Cobb back"
    // variety, but a bare "Ty Cobb" title must survive untouched.
    expect(unnumberedCardSegment("Ty Cobb", { year: 1909, setKey: "t206" })).toBe("player-ty-cobb");
  });

  it("strips the named 'Ty Cobb back' variety phrase without eating his name", () => {
    expect(unnumberedCardSegment("Ty Cobb Back", { year: 1909, setKey: "t206" })).toBe("player-ty-cobb");
  });

  it("keeps POSE words -- the checklist lists poses as separate cards", () => {
    // 1909-11-t206-baseball.trimmed.html: "Cy Seymour Portrait" (#433),
    // "Cy Seymour Batting" (#434), "Cy Seymour Pitching" (#435) are three
    // distinct checklist rows. This fix's back-brand list must never touch
    // a pose word.
    const portrait = unnumberedCardSegment("Sweet Caporal Cy Seymour Portrait", { year: 1909, setKey: "t206" });
    const batting = unnumberedCardSegment("Sweet Caporal Cy Seymour Batting", { year: 1909, setKey: "t206" });
    expect(portrait).toContain("portrait");
    expect(batting).toContain("batting");
    expect(portrait).not.toBe(batting);
  });

  it("does NOT strip 'back' as a bare pose word off this set's scope", () => {
    // "Schulte Back view" / "Schulte Front View" is a real checklist pose
    // pair on t206 (not a back-brand). This fix's own back-brand list never
    // lists a bare "back" token -- only "<named-brand> ... back" phrases.
    expect(unnumberedCardSegment("Schulte Back View", { year: 1909, setKey: "t206" }))
      .toContain("back");
  });

  it("is scoped to setKey t206 ONLY -- this fix's own strip never fires off it", () => {
    // "Piedmont" and "Factory 25" are unambiguous T206 back-brand/factory
    // vocabulary with no coincidental overlap in the generic
    // checklist-parallel corpus (unlike "Old Mill"/"Red Cross"/"Carolina
    // Brights", whose individual words happen to collide with OTHER
    // products' real parallel names and are stripped by the pre-existing,
    // unscoped corpus regardless of this fix). On any setKey other than
    // "t206" this fix's own T206_BACK_BRAND_PHRASES strip must not run at
    // all, so both survive whole.
    expect(unnumberedCardSegment("Piedmont Smith", { year: 2020, setKey: "topps" }))
      .toBe("player-piedmont-smith");
    expect(unnumberedCardSegment("Factory 25 Smith", { year: 2020, setKey: "topps" }))
      .toBe("player-factory-25-smith");
  });

  it("falls back to the untouched raw string when the residue is ENTIRELY back-brand vocabulary", () => {
    // Absent beats wrong: never strip to nothing.
    expect(unnumberedCardSegment("Sweet Caporal Piedmont", { year: 1909, setKey: "t206" }))
      .not.toBeNull();
  });

  it("end to end through computeHobbyIqCardId: the three real vendor spellings collapse onto one slug", () => {
    expect(t206("Sweet Caporal Ty Cobb")).toBe(t206("Ty Cobb"));
    expect(t206("Piedmont Ty Cobb")).toBe(t206("Ty Cobb"));
    expect(t206("Ty Cobb Piedmont")).toBe(t206("Ty Cobb"));
    expect(t206("Ty Cobb")).toBe("hiq:baseball:1909:t206:player-ty-cobb:base:no-auto");
  });

  // CF-BACK-BRANDS-STRIP-AS-PHRASES-NOT-BARE-TOKENS (owner-approved
  // 2026-09-22, fixing this PR's own defect before merge).
  //
  // THE DEFECT. The first cut put bare "red" in a per-TOKEN strip set (for
  // "Red Cross"), but the checklist has #95 Ty Cobb GREEN Portrait and #96
  // Ty Cobb RED Portrait as DISTINCT cards -- a per-token strip cannot tell
  // "Red" the COLOUR from "Red" the first word of "Red Cross" the BRAND, so
  // it deleted it either way, collapsing "Ty Cobb Red Portrait" onto the
  // same id as "Ty Cobb Portrait". Fixed: every brand is now a whole-PHRASE
  // regex (multi-word brands matched as complete phrases; surviving
  // single-word brands matched as whole words), so a bare colour/common word
  // that happens to share a syllable with a brand name is never touched.
  it("FOUR distinct ids for Ty Cobb's four real checklist rows (#95-98), never collapsed by the colour word", () => {
    // tests/fixtures/sportscardchecklist/1909-11-t206-baseball.trimmed.html:
    //   #95 Ty Cobb Green Portrait   #96 Ty Cobb Red Portrait
    //   #97 Ty Cobb Bat off Shoulder #98 Ty Cobb Bat on Shoulder
    const redPortrait = unnumberedCardSegment("Ty Cobb Red Portrait", { year: 1909, setKey: "t206" });
    const greenPortrait = unnumberedCardSegment("Ty Cobb Green Portrait", { year: 1909, setKey: "t206" });
    const batOff = unnumberedCardSegment("Ty Cobb Bat Off Shoulder", { year: 1909, setKey: "t206" });
    const batOn = unnumberedCardSegment("Ty Cobb Bat On Shoulder", { year: 1909, setKey: "t206" });
    expect(redPortrait).toBe("player-ty-cobb-red-portrait");
    expect(greenPortrait).toBe("player-ty-cobb-green-portrait");
    expect(batOff).toBe("player-ty-cobb-bat-off-shoulder");
    expect(batOn).toBe("player-ty-cobb-bat-on-shoulder");
    expect(new Set([redPortrait, greenPortrait, batOff, batOn]).size).toBe(4);
    // Also true with a leading noise word ahead of the name (the shape the
    // real defect was found in).
    expect(unnumberedCardSegment("T206 Ty Cobb Red Portrait", { year: 1909, setKey: "t206" }))
      .toBe("player-t206-ty-cobb-red-portrait");
  });

  it("'Red Cross' the BRAND still strips as a phrase, even though 'Red' alone must not", () => {
    expect(unnumberedCardSegment("Red Cross Harry Niles", { year: 1909, setKey: "t206" }))
      .toBe("player-harry-niles");
    // Non-adjacent "Red" ... "Cross" is not the phrase and must not strip
    // either word.
    expect(unnumberedCardSegment("Red Sox Cross", { year: 1909, setKey: "t206" }))
      .toBe("player-red-sox-cross");
  });

  it("MUTATION CHECK: a bare-token strip (the original defect) would fail this exact case", () => {
    // Proves the "Red Cross" phrase test above is actually exercising
    // phrase-anchoring and not passing for an unrelated reason: a MUTANT
    // that reverts to the original per-token strip (bare "red" removed
    // wherever it appears) reproduces the collapse this PR fixes --
    // "Ty Cobb Red Portrait" loses its colour and equals "Ty Cobb Portrait".
    // The real function must disagree with the mutant on this exact pair.
    const bareTokenMutant = (raw: string): string => {
      const bare = new Set(["sweet", "caporal", "old", "mill", "polar", "bear",
        "red", "cross", "american", "beauty", "broad", "leaf", "carolina",
        "brights", "piedmont", "sovereign", "hindu", "cycle", "tolstoi",
        "drum", "lenox", "uzit", "coupon"]);
      return raw.split(/\s+/).filter((t) => !bare.has(t.toLowerCase())).join("-").toLowerCase();
    };
    const mutantRedPortrait = bareTokenMutant("Ty Cobb Red Portrait");
    const mutantPlainPortrait = bareTokenMutant("Ty Cobb Portrait");
    // The mutant (bare-token strip, the original defect) collapses both
    // titles onto the SAME residue -- proving it is a real regression, not
    // a strawman.
    expect(mutantRedPortrait).toBe(mutantPlainPortrait);
    // The actual fix must NOT collapse them.
    expect(unnumberedCardSegment("Ty Cobb Red Portrait", { year: 1909, setKey: "t206" }))
      .not.toBe(unnumberedCardSegment("Ty Cobb Portrait", { year: 1909, setKey: "t206" }));
  });

  it("COLLISION SWEEP: no word in the back-brand vocabulary is a checklist player/pose/colour/cap word once phrase-anchored", () => {
    // Every distinct word across every #NNN row in the 550-row checklist
    // fixture (player names, poses, colours, cap status: "batting",
    // "portrait", "red", "green", "cap", "glove", "shoulder", "chest", every
    // surname, ...), cross-checked against the back-brand vocabulary. Only
    // "red" and "cross" overlap (from the "Red Cross" brand name), and both
    // are proven here to survive as bare tokens -- they are removed ONLY as
    // the exact adjacent two-word phrase.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "sportscardchecklist", "1909-11-t206-baseball.trimmed.html"),
      "utf-8",
    );
    const rowRe = /#(\d+)\s+([A-Za-z.,'\-/ ]+?)\s*<\/h5>/g;
    const checklistWords = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html))) {
      for (const w of m[2].toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean)) {
        checklistWords.add(w);
      }
    }
    expect(checklistWords.size).toBeGreaterThan(500);

    const brandWords = [
      "sweet", "caporal", "old", "mill", "polar", "bear", "red", "cross",
      "american", "beauty", "broad", "leaf", "carolina", "brights",
      "el", "principe", "de", "gales", "epdg",
      "piedmont", "sovereign", "hindu", "cycle", "tolstoi", "drum", "lenox", "uzit", "coupon",
      "factory", "series",
    ];
    const overlap = brandWords.filter((w) => checklistWords.has(w));
    // The known, adjudicated overlap -- everything else must be disjoint.
    expect(overlap.sort()).toEqual(["cross", "red"]);

    // Every overlapping word must survive as a BARE token next to a name --
    // proving the fix strips by phrase, never by bare membership.
    for (const w of overlap) {
      const title = `Ty Cobb ${w[0].toUpperCase()}${w.slice(1)}`;
      const seg = unnumberedCardSegment(title, { year: 1909, setKey: "t206" });
      expect(seg, `"${title}" must keep "${w}"`).toContain(w);
    }
  });
});
