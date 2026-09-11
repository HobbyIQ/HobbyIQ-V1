/**
 * CF-A-DECLARED-PARALLEL-IS-NOT-A-CARD-LINE (Drew, 2026-09-09).
 *
 * "Class 1 Blue" is character-for-character the shape of a card line
 * ("BD 154 Adley Rutschman"): a short word, a digit, a capitalised word. So
 * the ingest's card-line guard skipped 1,200 of 2017 Gold Label's 1,500 rows
 * while the 300 bare "Class N" rows (no trailing word) sailed through. Prod
 * carried exactly that split.
 *
 * The guard is RIGHT in general and is NOT widened here: the exemption is
 * scoped to the individual names a product's OWN manifest declares in
 * `parallelVocabulary`, by exact match, never by pattern. The mutation checks
 * below are the point of this file -- a real card line must stay a card line
 * with a vocabulary loaded, and one product's vocabulary must never exempt a
 * name for another product.
 *
 * The sibling rulings that share this investigation -- the named-insert setKey
 * and the 1997 Finest tier-from-number deriver rule -- move the I9 derivation
 * stamp, so they ship in their own PR with the census re-baseline they owe.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isCardLineParallel, declaredParallels } = require("../scripts/ingest-checklist-csv-to-catalog.cjs");

describe("a declared parallel is not a card line", () => {
  const goldLabel = declaredParallels({
    parallelVocabulary: ["Class 1", "Class 1 Blue", "Class 2 Black", "Class 3 Gold"],
  });
  const none = declaredParallels({});

  it("admits the Gold Label vocabulary the manifest declares", () => {
    expect(isCardLineParallel("Class 1 Blue", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class 2 Black", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class 1", goldLabel)).toBe(false);
  });

  it("is case- and whitespace-insensitive but never a pattern", () => {
    expect(isCardLineParallel("class 1 blue", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class  1   Blue", goldLabel)).toBe(false);
    // Declared "Class 1 Blue" must NOT admit an undeclared sibling.
    expect(isCardLineParallel("Class 1 Purple", goldLabel)).toBe(true);
  });

  // THE MUTATION CHECK. The exemption must not widen the guard for anyone
  // else: real card lines stay card lines, with and without a vocabulary.
  it("still reads real card lines as card lines — even with a vocabulary loaded", () => {
    for (const vocab of [none, goldLabel]) {
      expect(isCardLineParallel("Level 3 Aaron Judge", vocab)).toBe(true);
      expect(isCardLineParallel("BD 154 Adley Rutschman", vocab)).toBe(true);
      expect(isCardLineParallel("100 Mike Trout", vocab)).toBe(true);
    }
  });

  /**
   * PRE-EXISTING GAP, pinned rather than silently widened.
   *
   * CARD_LINE_PARALLEL's prefix is `[A-Za-z]{0,5}`, so a SIX-letter lead word
   * never matches at all: "Series 2 Mike Trout" is not seen as a card line
   * today, on main, and was not before this change either ("Class" and
   * "Level" are five letters and do match). Widening the cap to admit it is a
   * change to a guard shared by every product and belongs in its own PR with
   * its own blast-radius measurement — this PR only scopes an EXEMPTION and
   * must not quietly alter what the guard catches. Pinned so the day someone
   * does widen it, this expectation fails and the decision is made on purpose.
   */
  it("does NOT catch a six-letter lead word (pre-existing, unchanged here)", () => {
    expect(isCardLineParallel("Series 2 Mike Trout", none)).toBe(false);
    expect(isCardLineParallel("Series 2 Mike Trout", goldLabel)).toBe(false);
  });

  it("gives no product an exemption it did not declare", () => {
    expect(isCardLineParallel("Class 1 Blue", none)).toBe(true);
  });

  it("keeps the pre-existing non-card-line exceptions working", () => {
    expect(isCardLineParallel("1990 Bowman", none)).toBe(false);
    expect(isCardLineParallel("20 in '20", none)).toBe(false);
    expect(isCardLineParallel("3 Color Patch", none)).toBe(false);
  });
});
