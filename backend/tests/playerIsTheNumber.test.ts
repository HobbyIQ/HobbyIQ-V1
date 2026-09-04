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
