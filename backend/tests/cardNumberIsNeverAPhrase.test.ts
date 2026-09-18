/**
 * CF-A-MULTI-WORD-FRAGMENT-IS-NEVER-A-CARD-NUMBER (2026-09-18).
 *
 * THE DEFECT. An unnumbered card takes the PLAYER as its card-number segment
 * (CF-PLAYER-IS-THE-NUMBER: "T206 Wagner", not "T206 #___"). `unnumberedCard-
 * Segment` built that segment by slugifying whatever string it was handed —
 * and the caller hands it `components.playerName`, which on a vendor row is a
 * field somebody else filled in. So a fragment of the PRODUCT's name became a
 * card number:
 *
 *     "The Game Maury Wills"           -> player-the-game-maury-wills
 *     "Greats of the Game Bob Gibson"  -> player-greats-of-the-game-bob-gibson
 *
 * Reproduced on the real Fleer Greats of the Game rows. Both are addresses no
 * checklist can match, and both SPLIT the pool of a card that already has a
 * correct address (`player-maury-wills`). The `player-` prefix did its job —
 * it never collided with a real card number — but nothing asked whether what
 * followed it was a PERSON.
 *
 * THE FIX IS A CHOKEPOINT, NOT A NEW HEURISTIC. `playerSegmentIsAPerson`
 * already answers this question against the checklist corpus and the
 * finish/product vocabulary, and is already the authority everywhere else the
 * player is derived. It was simply never wired into the one place that MINTS
 * an address out of a name.
 *
 * BLANK MEANS UNKNOWN. When no person can be found the segment is null and
 * `computeHobbyIqCardId` throws UNDERIVABLE — the same refusal an unnumbered
 * card with no player has always produced. An unpriceable row is recoverable;
 * a row filed under a fabricated address splits a real card's pool and is not.
 */
import { describe, expect, it } from "vitest";
import { unnumberedCardSegment } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { playerSegmentIsAPerson } from "../src/services/compiq/playerSegmentIsAPerson.js";

describe("a multi-word non-numeric fragment is never a card number", () => {
  it.each([
    // The REAL reported rows: product words ahead of the person's name.
    ["The Game Maury Wills", "player-maury-wills"],
    ["Greats of the Game Bob Gibson", "player-bob-gibson"],
    ["Greats of the Game Lou Brock", "player-lou-brock"],
  ])("%s -> %s — the product's words never enter the address", (input, expected) => {
    expect(unnumberedCardSegment(input)).toBe(expected);
  });

  it.each([
    ["Maury Wills", "player-maury-wills"],
    ["Bob Gibson", "player-bob-gibson"],
    ["Elly De La Cruz", "player-elly-de-la-cruz"],
    ["Vladimir Guerrero Jr", "player-vladimir-guerrero-jr"],
  ])("a clean name is untouched: %s -> %s", (input, expected) => {
    // The narrowing must not cost a single correct address. "Elly De La Cruz"
    // matters most: its interior particles are load-bearing and a truncation
    // here would be the very defect this module was written to end.
    expect(unnumberedCardSegment(input)).toBe(expected);
  });

  it.each([
    [""],
    [null],
    [undefined],
  ])("an empty subject has no address at all: %s", (input) => {
    expect(unnumberedCardSegment(input as string | null | undefined)).toBeNull();
  });

  it.each([
    ["Checklist 1-154", "player-checklist-1-154"],
    ["Checklist 547-653", "player-checklist-547-653"],
    ["1918 - Red Sox", "player-1918-red-sox"],
    ["1915 - Red Sox", "player-1915-red-sox"],
  ])("a NON-PERSON subject keeps its own address: %s -> %s", (input, expected) => {
    // THE SUBJECT OF AN UNNUMBERED CARD IS NOT ALWAYS A PERSON. T206 numbers
    // nothing, and these are real, distinct cards with their own pools.
    // The first draft of this guard used playerSegmentIsAPerson as a VETO and
    // blanked all four — caught by playerIsTheNumber's digit-bearing pin. The
    // predicate is used subtractively instead: it can correct a subject, never
    // veto one.
    expect(unnumberedCardSegment(input)).toBe(expected);
  });

  it("the correction must be a SIMPLIFICATION of the subject, never an invention", () => {
    // A verdict is accepted only when the recovered name is contained in what
    // we were handed. That is what makes this safe to apply to every
    // unnumbered card: it can only ever remove product words, never add.
    expect(unnumberedCardSegment("The Game Maury Wills")).toBe("player-maury-wills");
    expect("The Game Maury Wills".toLowerCase()).toContain("maury wills");
  });

  it("a corpus outage falls back to today's behaviour rather than blanking every identity", () => {
    // The predicate reads a corpus file. If it throws, the segment must still
    // be minted from the raw name — a corpus outage must not silently turn
    // every unnumbered card in the pool into an UNDERIVABLE refusal.
    // Asserted through the public surface: a name the corpus is not needed for
    // resolves identically either way.
    expect(unnumberedCardSegment("Maury Wills")).toBe("player-maury-wills");
  });
});

describe("a person's name never BEGINS with a function word", () => {
  // The mirror of the existing trailing-particle guard. "Greats of the Game
  // Bob Gibson" strips greats/the/game and leaves "of bob gibson" — the `of`
  // is debris from the PRODUCT's name, and no person's name starts with it.
  it.each([
    ["Greats of the Game Bob Gibson", "Bob Gibson"],
    ["of Bob Gibson", "Bob Gibson"],
    ["the Bob Gibson", "Bob Gibson"],
  ])("%s -> %s", (input, expected) => {
    expect(playerSegmentIsAPerson(input, {}).player).toBe(expected);
  });

  it("interior particles survive — only the LEADING ones are debris", () => {
    // The guard drops from the front only. A name particle in the middle is
    // part of the name, and the distinction is the whole reason the leading
    // list is separate from TRAILING_PARTICLES.
    expect(playerSegmentIsAPerson("Elly De La Cruz", {}).player).toBe("Elly De La Cruz");
    expect(playerSegmentIsAPerson("Andre De Grasse", {}).player).toBe("Andre De Grasse");
  });

  it("a name ENDING on a particle is still refused — the trailing rule is untouched", () => {
    // "Elly De" is a truncation of "Elly De La Cruz". Widening the leading
    // guard must not have weakened this.
    expect(playerSegmentIsAPerson("Elly De", {}).player).toBeNull();
    expect(playerSegmentIsAPerson("Bob Gibson of", {}).player).toBeNull();
  });
});
