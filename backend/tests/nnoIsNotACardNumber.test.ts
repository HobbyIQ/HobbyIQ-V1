// CF-NNO-IS-NOT-A-CARD-NUMBER (Drew, 2026-08-18).
//
// `nno` means "no number". It is an ABSENCE, not an identity — but slugGuard
// only refused "", "null" and "undefined", so `nno` passed as though it were a
// real card number and every unnumbered card in a set collapsed onto one slug.
//
// Measured in sold_comps before the fix: 50,989 rows on a `:nno:` slug, and
// 637 of those slugs pooled two or more different players — 47,061 sales.
//
//   304 players, 3,650 sales, $3.95 .. $10,675    1909 t206 nno
//   274 players, 3,493 sales, $0.94 .. $655,960   1993 tcg-other leb nno
//   395 players, 1,865 sales, $3.49 .. $103,700   1909 unknown nno
//
// A pool spanning $0.94 to $655,960 cannot price anything. Same defect as the
// Topps Traded Tiffany bug — one pool, several cards — at hundreds of cards.

import { describe, it, expect } from "vitest";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

const base = { sport: "baseball", year: 1964, normalizedSetKey: "topps" };

describe("CF-NNO-IS-NOT-A-CARD-NUMBER", () => {
  // AMENDED by CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). Every value
  // below is still REFUSED — that is what this file has always been about and
  // nothing here got weaker. What changed is that the refusals are now told
  // apart by NAME, because they are two different facts:
  //
  //   ASSERTED  the source SAID the card has no number (`nno`, `unnumbered`).
  //             With a player this is an ANSWER (CF-PLAYER-IS-THE-NUMBER);
  //             without one nothing identifies the row -> `cardnumber-missing`.
  //   UNPARSED  nothing readable arrived at all (blank, a stringified null, a
  //             bare "-" or "#"). Nobody asserted anything; the parser failed.
  //             -> `cardnumber-unparsed`, and a player is NOT a substitute.
  //
  // Collapsing them is what filed a 1987 Topps Traded Tiffany Greg Maddux —
  // whose title states #70T — at `...:player-todd-worrell:...`.
  it("refuses every spelling of 'this card has no number' as ASSERTED", () => {
    for (const n of ["nno", "NNO", " nno ", "no number", "no-number", "nonumber",
                     "n/a", "none", "unnumbered"]) {
      const g = guardSlugInputs({ ...base, cardNumber: n });
      expect(g.ok, `expected refusal for ${JSON.stringify(n)}`).toBe(false);
      expect(g.reasons).toContain("cardnumber-missing");
    }
  });

  it("refuses every spelling of 'nothing was read' as UNPARSED", () => {
    for (const n of ["-", "#", "", " ", "null", "undefined"]) {
      const g = guardSlugInputs({ ...base, cardNumber: n });
      expect(g.ok, `expected refusal for ${JSON.stringify(n)}`).toBe(false);
      expect(g.reasons).toContain("cardnumber-unparsed");
    }
  });

  it("THE AMENDMENT: a player rescues an ASSERTED absence but never an UNPARSED one", () => {
    // This is the whole ruling in two lines. `nno` + a player is the T206
    // Wagner shape and stays allowed; a BLANK + a player is a parse failure
    // wearing a name, and the player must not stand in for a number nobody
    // read — the number may well exist and belong to a different card.
    expect(guardSlugInputs({ ...base, cardNumber: "nno", playerName: "Hank Aaron" }).ok).toBe(true);
    const blank = guardSlugInputs({ ...base, cardNumber: "", playerName: "Hank Aaron" });
    expect(blank.ok).toBe(false);
    expect(blank.reasons).toContain("cardnumber-unparsed");
  });

  it("still accepts real card numbers, including odd but legitimate ones", () => {
    for (const n of ["30", "70T", "BDC-46", "CPA-CC", "US80", "1", "0573", "RS-9"]) {
      const g = guardSlugInputs({ ...base, cardNumber: n });
      expect(g.ok, `expected acceptance for ${JSON.stringify(n)}`).toBe(true);
      expect(g.reasons).toEqual([]);
    }
  });

  it("the refusal is what keeps unrelated cards out of one pool", () => {
    // Aaron, Williams and Mazeroski all landed on
    // hiq:baseball:1964:topps:nno:base:no-auto because the number was absent.
    // With the guard refusing, none of them gets a slug at all — an ABSENT
    // identity, which is strictly better than a shared wrong one.
    const aaron = guardSlugInputs({ ...base, cardNumber: "nno" });
    const williams = guardSlugInputs({ ...base, cardNumber: "NNO" });
    expect(aaron.ok).toBe(false);
    expect(williams.ok).toBe(false);
  });
});
