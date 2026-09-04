/**
 * CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04).
 *
 * THE ROW THAT PROVES IT. A 1987 Topps Traded Tiffany Greg Maddux, PSA 10,
 * whose eBay title states `#70T` in words, was filed at
 *
 *     hiq:baseball:1987:topps:player-todd-worrell:base:no-auto
 *
 * Two defects met on that one row, and neither alone would have produced it:
 *
 *   1. `isUnnumberedCardNumber` returned true on an EMPTY string, so a
 *      cardNumber the parser FAILED TO READ was treated as "this card has no
 *      number" and fell into CF-PLAYER-IS-THE-NUMBER's pseudo-number branch.
 *   2. the player that branch reached for came from the VENDOR (TCA attributed
 *      the sale to Todd Worrell) because the ingest wrote
 *      `identity.playerName ?? guessPlayerFromTitle(title)` -- `??` never
 *      compares, so the vendor won whenever it had a value.
 *
 * This file pins both halves and the two things that must NOT change with
 * them: a genuinely unnumbered card still gets its player pseudo-number, and a
 * vendor player that merely spells a name differently is still accepted.
 */
import { describe, expect, it } from "vitest";
import {
  computeHobbyIqCardId,
  isUnnumberedCardNumber,
  isUnparsedCardNumber,
  unnumberedCardSegment,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";
import { deriveHobbyIqSlug } from "../src/services/portfolioiq/soldCompsStore.service.js";
import {
  playerTheTitleAllows,
  playerNameKey,
} from "../src/services/portfolioiq/playerTheTitleAllows.js";

// The real sale. Title as the seller wrote it; playerName as TCA sent it.
const MADDUX_TITLE = "1987 Topps Traded Tiffany #70T Greg Maddux Rookie RC PSA 10 GEM MINT";
const VENDOR_PLAYER_WRONG = "Todd Worrell";

describe("the two absences are different facts", () => {
  it("an ASSERTED absence is unnumbered, not unparsed", () => {
    for (const marker of ["NNO", "nno", "no-number", "unnumbered", "none", "N/A", "na"]) {
      expect(isUnnumberedCardNumber(marker)).toBe(true);
      expect(isUnparsedCardNumber(marker)).toBe(false);
    }
  });

  it("a BLANK cardNumber is unparsed, NOT unnumbered -- this is the defect", () => {
    for (const blank of ["", "   ", null, undefined, "null", "undefined"]) {
      // The line that was wrong: `!s` used to make this `true`.
      expect(isUnnumberedCardNumber(blank)).toBe(false);
      expect(isUnparsedCardNumber(blank)).toBe(true);
    }
  });
});

describe("computeHobbyIqCardId refuses to mint an identity out of a parse failure", () => {
  const maddux = {
    sport: "baseball", year: 1987, setKey: "Topps Traded Tiffany",
    cardNumber: "", parallel: "Base", isAuto: false,
    playerName: "Greg Maddux",
  };

  it("THE PIN: a blank cardNumber THROWS rather than minting `player-<name>`", () => {
    expect(() => computeHobbyIqCardId(maddux)).toThrow(/unparsed/i);
  });

  it("the same card WITH its number produces a numbered identity", () => {
    const slug = computeHobbyIqCardId({ ...maddux, cardNumber: "70T" });
    expect(slug).toContain(":70t:");
    expect(slug).not.toContain("player-");
  });

  it("a genuinely unnumbered card STILL gets its player pseudo-number", () => {
    // CF-PLAYER-IS-THE-NUMBER is not retracted -- this is the population it
    // was written for, and it must be untouched.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1909, setKey: "T206", cardNumber: "NNO",
      parallel: "Base", isAuto: false, playerName: "Honus Wagner",
    });
    expect(slug).toContain(":player-honus-wagner:");
    expect(unnumberedCardSegment("Honus Wagner")).toBe("player-honus-wagner");
  });

  it("a CHECKLIST may assert a blank number is an answer", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1997, setKey: "Donruss Signature Series",
      cardNumber: "", parallel: "Base", isAuto: true,
      playerName: "Ken Griffey Jr.", unnumberedByChecklist: true,
    });
    expect(slug).toContain(":player-ken-griffey-jr:");
  });

  it("an unnumbered card with NO player has no identity at all", () => {
    expect(() => computeHobbyIqCardId({
      sport: "baseball", year: 1909, setKey: "T206", cardNumber: "NNO",
      parallel: "Base", isAuto: false, playerName: null,
    })).toThrow(/no player/i);
  });
});

describe("slugGuard names the two absences separately", () => {
  const good = {
    sport: "baseball", year: 1987, normalizedSetKey: "topps",
    playerName: "Greg Maddux",
  };

  it("a blank cardNumber with a player is `cardnumber-unparsed`, NOT allowed through", () => {
    const r = guardSlugInputs({ ...good, cardNumber: "" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("cardnumber-unparsed");
  });

  it("an ASSERTED unnumbered card with a player still passes", () => {
    const r = guardSlugInputs({ ...good, cardNumber: "NNO" });
    expect(r.ok).toBe(true);
  });

  it("an ASSERTED unnumbered card with NO player is `cardnumber-missing`", () => {
    const r = guardSlugInputs({ ...good, cardNumber: "NNO", playerName: null });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("cardnumber-missing");
  });

  it("a checklist may assert a blank number is an answer", () => {
    const r = guardSlugInputs({ ...good, cardNumber: "", unnumberedByChecklist: true });
    expect(r.ok).toBe(true);
  });

  it("a real cardNumber is untouched by any of this", () => {
    expect(guardSlugInputs({ ...good, cardNumber: "70T" }).ok).toBe(true);
  });
});

describe("the title outranks the vendor's attributed player", () => {
  it("THE PIN: Worrell vs Maddux is IRRECONCILABLE -- neither is adopted", () => {
    const d = playerTheTitleAllows(VENDOR_PLAYER_WRONG, "Greg Maddux");
    expect(d.outcome).toBe("irreconcilable");
    expect(d.player).toBeNull();
    expect(d.vendorOverruled).toBe(true);
  });

  it("the same name spelled differently is ONE person, not a conflict", () => {
    const pairs: Array<[string, string]> = [
      ["ken griffey jr", "Ken Griffey Jr."],
      ["LeBron James", "Lebron James"],
      ["Jose Ramirez", "José Ramírez"],
      ["O'Neill Paul", "Paul O Neill"],
    ];
    for (const [v, t] of pairs) {
      expect(playerTheTitleAllows(v, t).outcome).toBe("agree");
    }
  });

  it("an abbreviation is the same person and the FULLER spelling wins", () => {
    expect(playerTheTitleAllows("G. Maddux", "Greg Maddux")).toMatchObject({
      outcome: "agree", player: "Greg Maddux",
    });
    expect(playerTheTitleAllows("Greg Maddux", "Maddux")).toMatchObject({
      outcome: "agree", player: "Greg Maddux",
    });
  });

  it("a SAME-surname disagreement about the given name is still two people", () => {
    expect(playerTheTitleAllows("Barry Bonds", "Bobby Bonds").outcome).toBe("irreconcilable");
  });

  it("one side missing is not a conflict", () => {
    expect(playerTheTitleAllows("Greg Maddux", null).outcome).toBe("vendor-only");
    expect(playerTheTitleAllows(null, "Greg Maddux").outcome).toBe("title-only");
    expect(playerTheTitleAllows(null, null).outcome).toBe("neither");
  });

  it("playerNameKey folds accents, punctuation and suffixes", () => {
    expect(playerNameKey("José Ramírez")).toBe("jose ramirez");
    expect(playerNameKey("Ken Griffey Jr.")).toBe("ken griffey");
    expect(playerNameKey("“Kiki” Cuyler")).toBe("kiki cuyler");
  });
});

describe("deriveHobbyIqSlug: the Worrell/Maddux row end to end", () => {
  const row = {
    sport: "baseball", setName: "Topps Traded Tiffany", title: MADDUX_TITLE,
    cardYear: 1987, cardNumber: null, parallel: "Base", isAuto: false,
    playerName: VENDOR_PLAYER_WRONG, printRun: null,
  };

  it("THE PIN: the row NEVER lands on `player-todd-worrell`", () => {
    const d = deriveHobbyIqSlug(row as never);
    expect(d.slug ?? "").not.toContain("player-todd-worrell");
  });

  it("a vendor player that disagrees with the title is refused, not adopted", () => {
    // parseCardQuery reads "Greg Maddux" out of the title; TCA said Worrell.
    // Whether the number is read or not, the WRONG PLAYER never keys the row.
    const d = deriveHobbyIqSlug(row as never);
    expect((d.slug ?? "").toLowerCase()).not.toContain("worrell");
  });

  it("a blank cardNumber the title does not state leaves the row UNKEYED", () => {
    const d = deriveHobbyIqSlug({
      ...row,
      title: "Topps Traded Tiffany Greg Maddux Rookie",
      playerName: "Greg Maddux",
    } as never);
    expect(d.slug).toBeNull();
    expect(d.guard.reasons).toContain("cardnumber-unparsed");
  });

  it("a genuinely unnumbered vintage card still derives its player identity", () => {
    const d = deriveHobbyIqSlug({
      sport: "baseball", setName: "T206", title: "1909-11 T206 Honus Wagner",
      cardYear: 1909, cardNumber: "NNO", parallel: "Base", isAuto: false,
      playerName: "Honus Wagner", printRun: null,
    } as never);
    expect(d.slug).toContain("player-honus-wagner");
  });
});
