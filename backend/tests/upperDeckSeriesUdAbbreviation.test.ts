/**
 * CF-UD-SERIES-IS-THE-PRODUCT (2026-09-19, follow-on to D39).
 *
 * D39 (upperDeckExtendedSeriesVocab.test.ts) taught the deriver "Upper Deck
 * Series 1/2/Extended" -- but only the full "Upper Deck" spelling, because
 * productSetKeyForName's run-matcher only answers the exact words the
 * checklist itself carries. Prod reads on 2026-09-19 show three hockey sales
 * whose title abbreviates the maker to "UD" and fell through to the bare
 * `upper-deck` umbrella even though the checklist-backed catalog rows live
 * under the series-specific keys:
 *
 *   "2023-24 Upper Deck Series 2 Young Guns #492"      -> was `upper-deck`
 *   "2024 UD Extended Beehive #BH-24"                  -> was `upper-deck`
 *   "2022-23 UD Canvas #C99"                           -> was `upper-deck`
 *      (Canvas is deliberately NOT fixed here -- see the last describe below)
 *
 * This file pins the "UD" half of the fold: positive cases (the new UD
 * spellings resolve to their series key), negative cases (a title that only
 * *contains* "ud" as a substring, or names no series, must not match), and
 * flagship-untouched cases (every existing Upper Deck rule, and the other
 * sports' bare `upper-deck` umbrella, are unaffected).
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("UD abbreviation resolves to the registered series key", () => {
  it("resolves 'UD Series 1/One' and 'UD Series 2/Two'", () => {
    expect(normalizeSetKey("UD Series 1")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("UD Series One")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("2021-22 UD Series 1 Hockey")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("UD Series 2")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("UD Series Two")).toBe("upper-deck-series-2");
    // The exact prod title (#492 stripped by the caller before setName reaches
    // here, same as every other row in this file -- normalizeSetKey takes a
    // set name, not a full sale title).
    expect(normalizeSetKey("2023-24 UD Series 2 Young Guns")).toBe("upper-deck-series-2");
  });

  it("resolves 'UD Extended' and 'UD Extended Series', never as Series 1 or 2", () => {
    expect(normalizeSetKey("UD Extended")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("UD Extended Series")).toBe("upper-deck-extended-series");
    // The exact prod title from #2's evidence: "Extended Beehive" still reads
    // as Extended Series even with the insert name trailing it.
    expect(normalizeSetKey("2024 UD Extended Beehive")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("2024-25 UD Extended Series Hockey")).toBe("upper-deck-extended-series");
  });

  it("still resolves the full 'Upper Deck' spelling (unchanged by this rule)", () => {
    expect(normalizeSetKey("Upper Deck Series 1")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("Upper Deck Series 2")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("Upper Deck Extended Series")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("Upper Deck Extended")).toBe("upper-deck-extended-series");
  });
});

describe("the UD rule is anchored -- it does not widen", () => {
  it("does not match 'series' or 'extended' without a UD/Upper Deck maker word", () => {
    // No maker word at all.
    expect(normalizeSetKey("Series 1")).not.toBe("upper-deck-series-1");
    expect(normalizeSetKey("Extended Series")).not.toBe("upper-deck-extended-series");
  });

  it("does not match 'ud' as a mid-word accident, only a real segment", () => {
    // "superud-series-1" must not read as UD Series 1 on the trailing
    // substring -- the same prefix-is-not-an-identity defect class as
    // `superbowman-nscc` in setKeyReconciliation.ts.
    expect(normalizeSetKey("superud-series-1")).not.toBe("upper-deck-series-1");
  });

  it("does not read 'UD Series 10' as Series 1 (two-digit guard)", () => {
    const v = normalizeSetKey("UD Series 10 Something");
    expect(v).not.toBe("upper-deck-series-1");
  });

  it("does not infer a series from a bare UD insert name with no series word (Canvas is a documented follow-up, not fixed here)", () => {
    // CF-NEVER-GUESS-A-PRODUCT: the title does not say which series Canvas
    // belongs to, so the key must stay exactly where it is today rather than
    // guessing. This is the PR's stated follow-up -- resolving it needs the
    // checklist to decide by card number, not a title regex.
    const before = normalizeSetKey("UD Canvas");
    expect(before).not.toBe("upper-deck-series-1");
    expect(before).not.toBe("upper-deck-series-2");
    expect(before).not.toBe("upper-deck-extended-series");
  });
});

describe("flagship and sibling products are untouched", () => {
  it("leaves the bare Upper Deck umbrella and its other named products alone", () => {
    expect(normalizeSetKey("Upper Deck")).toBe("upper-deck");
    expect(normalizeSetKey("Upper Deck MVP")).toBe("upper-deck-mvp");
    expect(normalizeSetKey("Upper Deck Black Diamond")).toBe("upper-deck-black-diamond");
    expect(normalizeSetKey("UD Black Diamond")).toBe("upper-deck-black-diamond");
    expect(normalizeSetKey("Upper Deck SPx Finite")).toBe("spx-finite");
    expect(normalizeSetKey("Upper Deck Collector's Choice")).toBe("collectors-choice");
  });

  it("does not disturb the other sports' vintage bare `upper-deck` (no series keys exist there)", () => {
    // CF-UD-INSERT-LINES / exquisiteIsItsOwnProduct.test.ts already pins these;
    // repeated here because this PR's rule sits directly above the catch-all
    // these depend on. Baseball and basketball Upper Deck have no Series
    // 1/2/Extended products registered, and none of these titles carry the
    // words this rule matches on, so they must be unaffected either way.
    expect(normalizeSetKey("1989 Upper Deck Baseball")).toBe("upper-deck");
    expect(normalizeSetKey("2008 Upper Deck Sweet Spot Baseball")).toBe("upper-deck");
    expect(normalizeSetKey("1995-96 Upper Deck")).toBe("upper-deck");
  });
});
