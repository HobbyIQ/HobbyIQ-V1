// D28 -- the two card-number rules must not drift apart.
//
// parseTitleIdentity grew its own grader refusal on 2026-08-24
// (CF-A-GRADE-IS-NOT-A-CARD-NUMBER: GRADER_BEFORE_NUMBER, CONDITION_WORDS,
// standaloneCardNumber). cardNumberIntegrity is the shared statement of the
// same invariant, applied at the four emitters that never had it.
//
// Two rules for one invariant is how the invariant comes back: someone fixes a
// shape in one and the other keeps writing it. This file pins BOTH against the
// same corpus -- the 08-24 titles verbatim, plus the D28 shapes -- and asserts
// they agree on every one. A change to either that the other does not follow
// turns this red.

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { judgeCardNumber } from "../src/services/portfolioiq/cardNumberIntegrity.js";

/** The 08-24 corpus, verbatim from the CF comment in parseTitleIdentity, plus
 *  the D28 shapes. `expected` is what the card number must be -- null when the
 *  title states none that can be trusted. */
const CORPUS: Array<{ title: string; expected: string | null }> = [
  // CF-A-GRADE-IS-NOT-A-CARD-NUMBER, 2026-08-24 -- the three titles that split
  // one Wilt Chamberlain into cards #7 / #8 / #9 / #10.
  { title: "1972 Icee Bear Set Break Wilt Chamberlain PSA 9 MINT", expected: null },
  { title: "1972 Icee Bear Set Break Wilt Chamberlain SGC 8 NM-MT", expected: null },
  { title: "CGC 10 GEM MINT Entei Neo Revelation Movie Promo 34", expected: null },
  // The condition-word variants the grader-only check missed.
  { title: "1961 Topps Mickey Mantle PSA EX-MT 6", expected: null },
  { title: "1955 Bowman Willie Mays NR-MT", expected: null },
  // CF-CARDNUM-STANDALONE -- a bare number IS the card number in this shape.
  { title: "2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10", expected: "194" },
  // CF-STANDALONE-PREFIXED-CARDNUMBER -- a prefixed SKU with no hash.
  { title: "2025 Topps Stars of MLB SMLB-10 Shohei Ohtani Gold", expected: "SMLB-10" },
  // CF-GAME-USED-IS-NOT-A-SKU.
  { title: "2001 Fleer Legacy Game-Used Jersey Cal Ripken Jr", expected: null },
  // The D28 shapes.
  { title: "2018 Topps Chrome #150 Shohei Ohtani Refractor RC PSA 10", expected: "150" },
  { title: "2018 Topps Chrome Shohei Ohtani #83T-6 1983 Topps Baseball Refractor RC PSA 9", expected: "83T-6" },
  { title: "2022 Bowman Chrome #BCP-16 Jackson Holliday Blue Refractor", expected: "BCP-16" },
  { title: "2025 Topps #US175 Roki Sasaki RC", expected: "US175" },
];

describe("parseTitleIdentity and cardNumberIntegrity agree on every shape", () => {
  it.each(CORPUS)("$title", ({ title, expected }) => {
    const parsed = parseListingIdentity(title).cardNumber;
    // The parser's own answer, then the shared guard's ruling on it. The guard
    // is the seam every emitter now passes through, so what it returns is what
    // reaches the pool.
    const judged = judgeCardNumber(parsed, title).cardNumber;
    expect(judged).toBe(expected);
    // And the parser must not be producing something the guard then has to
    // throw away: where the guard keeps an answer, it is the parser's answer,
    // and where the parser has an answer, the guard keeps it.
    if (parsed !== null && judged !== null) expect(judged).toBe(parsed.toUpperCase());
  });
});

describe("the 08-24 refusals are still the parser's own", () => {
  // Pinned directly, not through the guard: if someone deletes
  // GRADER_BEFORE_NUMBER these go red HERE, not silently at the seam.
  it.each([
    "1972 Icee Bear Set Break Wilt Chamberlain PSA 9 MINT",
    "1972 Icee Bear Set Break Wilt Chamberlain SGC 8 NM-MT",
    "CGC 10 GEM MINT Entei Neo Revelation Movie Promo 34",
    "1961 Topps Mickey Mantle PSA EX-MT 6",
  ])("parseListingIdentity refuses the grade in %s", (title) => {
    expect(parseListingIdentity(title).cardNumber).toBeNull();
  });

  it("still reads the bare card number where one is really stated", () => {
    expect(parseListingIdentity("2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10").cardNumber).toBe("194");
  });
});
